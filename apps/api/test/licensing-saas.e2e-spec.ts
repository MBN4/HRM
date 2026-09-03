/**
 * Proves the SaaS-mode (LICENSE_MODE=saas, the default) side of 0.6's
 * feature-flag/licensing system end to end over real HTTP: an active
 * subscription resolves its edition's flags, a canceled/past-due
 * subscription disables them (`@RequireFeature` returns 403), seat-cap
 * over-cap is FLAGGED rather than blocking in this mode, the platform-admin
 * flag-override endpoint can grant/revoke a flag independent of edition,
 * and none of it leaks across tenants (RLS).
 *
 * `PLATFORM_MODE_ENABLED` is forced on here (before the Nest app is
 * compiled) purely to exercise the flag-override admin endpoint — jest
 * runs each test file in its own worker process, so this does not affect
 * `tenant-resolution.e2e-spec.ts`'s proof that platform routes are
 * rejected while the flag is off by default.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

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
const TENANT_A_SLUG = 'lic-saas-tenant-a';
const TENANT_B_SLUG = 'lic-saas-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('licensing — SaaS mode (e2e)', () => {
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
      data: { name: 'Licensing SaaS Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Licensing SaaS Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@lic-saas-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    tokenA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@lic-saas-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
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

  describe('subscription status drives entitlement', () => {
    it('no subscription at all resolves to an empty, blocked entitlement', async () => {
      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body).toMatchObject({ mode: 'saas', edition: null, flags: [], blocked: true });
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });

    it('an ACTIVE PROFESSIONAL subscription enables the PROFESSIONAL edition flags', async () => {
      await prisma.subscription.create({ data: { tenantId: tenantAId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.blocked).toBe(false);
      expect(res.body.edition).toBe('PROFESSIONAL');
      expect(res.body.flags.sort()).toEqual(
        // FEATURE_FLAGS.WEBHOOKS joined this list in step 3.3 — see
        // docs/conventions/integrations.md.
        [FEATURE_FLAGS.ADVANCED_REPORTING, FEATURE_FLAGS.CUSTOM_ROLES, FEATURE_FLAGS.API_ACCESS, FEATURE_FLAGS.WEBHOOKS].sort(),
      );
      // ENTERPRISE-only flags must NOT be present for a PROFESSIONAL subscription.
      expect(res.body.flags).not.toContain(FEATURE_FLAGS.SSO);

      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(200);
    });

    it('a CANCELED subscription disables every gated feature', async () => {
      await prisma.subscription.update({ where: { tenantId: tenantAId }, data: { status: 'CANCELED' } });

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body).toMatchObject({ flags: [], blocked: true });
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });

    it('a PAST_DUE subscription also disables every gated feature', async () => {
      await prisma.subscription.update({ where: { tenantId: tenantAId }, data: { status: 'PAST_DUE' } });

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body).toMatchObject({ flags: [], blocked: true });
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });

    it('reactivating (TRIAL) restores the edition flags', async () => {
      await prisma.subscription.update({ where: { tenantId: tenantAId }, data: { status: 'TRIAL' } });

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.blocked).toBe(false);
      expect(res.body.flags).toContain(FEATURE_FLAGS.ADVANCED_REPORTING);
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(200);
    });
  });

  describe('seat cap in SaaS mode is FLAGGED, not blocking', () => {
    it('exceeding the seat cap surfaces overCap=true but does not disable gated features', async () => {
      await prisma.subscription.update({ where: { tenantId: tenantAId }, data: { status: 'ACTIVE', seatCap: 1 } });
      // adminA is already 1 ACTIVE user; add a second to exceed a cap of 1.
      await prisma.user.create({
        data: { tenantId: tenantAId, email: 'second@lic-saas-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.seatCap).toMatchObject({ activeUserCount: 2, seatCap: 1, overCap: true });
      expect(res.body.blocked).toBe(false);
      expect(res.body.flags).toContain(FEATURE_FLAGS.ADVANCED_REPORTING);
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(200);
    });
  });

  describe('platform-admin flag overrides', () => {
    it('a granted override adds a flag outside the edition default', async () => {
      await request(app.getHttpServer())
        .patch(`/platform/licensing/flags/${tenantAId}`)
        .send({ flagKey: FEATURE_FLAGS.SSO, enabled: true })
        .expect(200);

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.flags).toContain(FEATURE_FLAGS.SSO);
    });

    it('a revoking override removes a flag the edition would otherwise grant', async () => {
      await request(app.getHttpServer())
        .patch(`/platform/licensing/flags/${tenantAId}`)
        .send({ flagKey: FEATURE_FLAGS.ADVANCED_REPORTING, enabled: false })
        .expect(200);

      const res = await entitlements(TENANT_A_SLUG, tokenA).expect(200);
      expect(res.body.flags).not.toContain(FEATURE_FLAGS.ADVANCED_REPORTING);
      await advancedReportingDemo(TENANT_A_SLUG, tokenA).expect(403);
    });

    it('rejects an unknown tenant id', async () => {
      await request(app.getHttpServer())
        .patch('/platform/licensing/flags/00000000-0000-0000-0000-000000000000')
        .send({ flagKey: FEATURE_FLAGS.SSO, enabled: true })
        .expect(404);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant A's subscription/overrides never leak into tenant B's entitlements", async () => {
      const res = await entitlements(TENANT_B_SLUG, tokenB).expect(200);
      expect(res.body).toMatchObject({ edition: null, flags: [], blocked: true });
    });
  });
});
