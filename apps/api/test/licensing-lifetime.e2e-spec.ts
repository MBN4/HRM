/**
 * Proves the lifetime/on-prem-mode (LICENSE_MODE=lifetime) side of 0.6's
 * feature-flag/licensing system end to end over real HTTP: a validly
 * signed + activated license enables its flags, a tampered or expired
 * license is rejected, a license signed with the wrong key is rejected,
 * seat-cap over-cap BLOCKS (unlike SaaS's "flagged"), the offline
 * challenge-response activation flow binds a file to the request it
 * answers, and none of it leaks across tenants (RLS).
 *
 * `LICENSE_MODE`/`PLATFORM_MODE_ENABLED` are forced before the Nest app is
 * compiled — jest runs each test file in its own worker process, so this
 * does not affect other e2e files' defaults (saas / platform-disabled).
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.LICENSE_MODE = 'lifetime';
process.env.PLATFORM_MODE_ENABLED = 'true';

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { FEATURE_FLAGS } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'lic-life-tenant-a';
const TENANT_B_SLUG = 'lic-life-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });
// Signs tokens directly with the SAME real private key the running app verifies against
// (for a genuinely valid — or deliberately expired/tampered — license), and separately with an
// unrelated throwaway key (for the "wrong key" case). Neither path touches production code.
const realPrivateKey = readFileSync(join(__dirname, '../keys/license-private-dev.pem'), 'utf8');
const licenseJwt = new JwtService();

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('licensing — lifetime/on-prem mode (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Licensing Lifetime Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Licensing Lifetime Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@lic-life-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    tokenA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@lic-life-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
    tokenB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function entitlements(tenantSlug: string, token: string) {
    return request(app.getHttpServer())
      .get('/licensing/entitlements')
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`);
  }

  function advancedReportingDemo(tenantSlug: string, token: string) {
    return request(app.getHttpServer())
      .get('/licensing/demo/advanced-reporting')
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`);
  }

  function issue(body: unknown) {
    return request(app.getHttpServer()).post('/platform/licensing/issue').send(body);
  }

  function activate(tenantSlug: string, token: string, licenseFile: string) {
    return request(app.getHttpServer())
      .post('/licensing/activation/complete')
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .send({ licenseFile });
  }

  describe('no license activated yet', () => {
    it('resolves to an empty, blocked entitlement', async () => {
      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body).toMatchObject({ mode: 'lifetime', edition: null, flags: [], blocked: true });
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });
  });

  describe('a validly-signed, activated license enables its flags', () => {
    let licenseFile: string;

    it('the platform can issue a signed license file', async () => {
      const res = await issue({
        tenantId: tenantAId,
        edition: 'ENTERPRISE',
        enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING, FEATURE_FLAGS.SSO],
        seatCap: 10,
      }).expect(201);
      expect(typeof res.body.licenseFile).toBe('string');
      licenseFile = res.body.licenseFile;
    });

    it('activating it makes those flags resolve for the tenant', async () => {
      await activate(TENANT_A_SLUG, tokenA, licenseFile).expect(201);

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.blocked).toBe(false);
      expect(res.body.edition).toBe('ENTERPRISE');
      expect(res.body.flags.sort()).toEqual([FEATURE_FLAGS.ADVANCED_REPORTING, FEATURE_FLAGS.SSO].sort());
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(200);
    });
  });

  describe('rejected license files', () => {
    it('rejects a tampered license (signature no longer matches the payload)', async () => {
      const res = await issue({
        tenantId: tenantAId,
        edition: 'STARTER',
        enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING],
        seatCap: 5,
      }).expect(201);
      const [headerB64, payloadB64, signatureB64] = (res.body.licenseFile as string).split('.');

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      payload.seatCap = 999999;
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tampered = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

      await activate(TENANT_A_SLUG, tokenA, tampered).expect(400);
    });

    it('rejects an expired license', async () => {
      const expired = licenseJwt.sign(
        {
          tenantId: tenantAId,
          tenantName: 'Licensing Lifetime Tenant A',
          edition: 'STARTER',
          enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING],
          seatCap: 5,
        },
        { algorithm: 'RS256', privateKey: realPrivateKey, expiresIn: '1ms' },
      );
      // Give the 1ms expiry time to actually elapse before verification.
      await new Promise((resolve) => setTimeout(resolve, 25));

      await activate(TENANT_A_SLUG, tokenA, expired).expect(400);
    });

    it('rejects a license signed with the wrong key entirely', async () => {
      const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const wrongKeyToken = licenseJwt.sign(
        {
          tenantId: tenantAId,
          tenantName: 'Licensing Lifetime Tenant A',
          edition: 'ENTERPRISE',
          enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING, FEATURE_FLAGS.SSO],
          seatCap: 100,
        },
        { algorithm: 'RS256', privateKey: wrongPrivateKey },
      );

      await activate(TENANT_A_SLUG, tokenA, wrongKeyToken).expect(400);
    });

    it('rejects a license issued for a different tenant', async () => {
      const res = await issue({
        tenantId: tenantBId,
        edition: 'ENTERPRISE',
        enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING],
        seatCap: 10,
      }).expect(201);

      await activate(TENANT_A_SLUG, tokenA, res.body.licenseFile).expect(400);
    });
  });

  describe('seat cap in lifetime mode BLOCKS (unlike SaaS\'s "flagged")', () => {
    it('an over-cap license resolves to an empty, blocked entitlement despite being validly signed and active', async () => {
      const res = await issue({
        tenantId: tenantAId,
        edition: 'ENTERPRISE',
        enabledFlags: [FEATURE_FLAGS.ADVANCED_REPORTING, FEATURE_FLAGS.SSO],
        seatCap: 1,
      }).expect(201);
      await activate(TENANT_A_SLUG, tokenA, res.body.licenseFile).expect(201);
      // adminA is already 1 ACTIVE user; add a second to exceed a cap of 1.
      await prisma.user.create({
        data: { tenantId: tenantAId, email: 'second@lic-life-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });

      const entitlementRes = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(entitlementRes.body.seatCap).toMatchObject({ activeUserCount: 2, seatCap: 1, overCap: true });
      expect(entitlementRes.body.blocked).toBe(true);
      expect(entitlementRes.body.flags).toEqual([]);
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });
  });

  describe('offline activation via challenge-response', () => {
    it('binds a license file to the specific challenge it was issued for', async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/licensing/activation/challenge')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(201);
      const { challenge } = challengeRes.body;
      expect(typeof challenge).toBe('string');

      const issueRes = await issue({
        tenantId: tenantBId,
        edition: 'PROFESSIONAL',
        enabledFlags: [FEATURE_FLAGS.CUSTOM_ROLES],
        seatCap: 10,
        challenge,
      }).expect(201);

      await activate(TENANT_B_SLUG, tokenB, issueRes.body.licenseFile).expect(201);
      const res = await entitlements(TENANT_B_SLUG, tokenB).expect(200);
      expect(res.body.flags).toEqual([FEATURE_FLAGS.CUSTOM_ROLES]);
    });

    it('rejects a license answering a DIFFERENT (stale) challenge than the one currently pending', async () => {
      const staleIssueRes = await issue({
        tenantId: tenantBId,
        edition: 'PROFESSIONAL',
        enabledFlags: [FEATURE_FLAGS.CUSTOM_ROLES],
        seatCap: 10,
        challenge: 'a-challenge-nobody-ever-requested',
      }).expect(201);

      await request(app.getHttpServer())
        .post('/licensing/activation/challenge')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(201);

      await activate(TENANT_B_SLUG, tokenB, staleIssueRes.body.licenseFile).expect(400);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant A's activated license never leaks into tenant B's entitlements", async () => {
      const res = await entitlements(TENANT_B_SLUG, tokenB).expect(200);
      // Tenant B's own PROFESSIONAL license from the offline-activation test above is what
      // should show here — NOT tenant A's ENTERPRISE license from earlier in this file.
      expect(res.body.edition).toBe('PROFESSIONAL');
      expect(res.body.flags).toEqual([FEATURE_FLAGS.CUSTOM_ROLES]);
    });
  });
});
