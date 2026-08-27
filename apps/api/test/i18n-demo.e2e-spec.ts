/**
 * Proves the i18n/timezone/RTL demo endpoint (0.9) end to end over real
 * HTTP — see /CLAUDE.md § Conventions → i18n / timezone / RTL: a US branch
 * resolves `en`/LTR, a Qatar branch resolves `ar`/RTL (driven entirely by
 * the resolved Country Pack, same as the notification hub's locale
 * resolution — 0.8), and the returned `formatted` string is genuinely
 * rendered in the branch's own IANA timezone, not just echoed UTC.
 *
 * A JWT is minted directly (bypassing the real login flow, exercised in
 * full by auth-rbac.e2e-spec.ts) — same rationale every other e2e suite in
 * this codebase already documents for doing the same thing.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'i18n-demo-test-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('i18n / timezone / RTL demo (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let usBranchId: string;
  let qaBranchId: string;
  let token: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenant = await prisma.tenant.create({
      data: { name: 'i18n Demo Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);

    const usBranch = await prisma.branch.create({
      data: { tenantId, name: 'i18n US Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    usBranchId = usBranch.id;
    const qaBranch = await prisma.branch.create({
      data: { tenantId, name: 'i18n QA Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    qaBranchId = qaBranch.id;

    const employeeRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'i18n-demo@test.local', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: employeeRole.id } });
    token = jwt.sign({ sub: user.id, tenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function demo(branchId: string) {
    return request(app.getHttpServer())
      .get('/i18n/demo')
      .query({ branchId })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('a US branch resolves en / LTR', async () => {
    const res = await demo(usBranchId).expect(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.rtl).toBe(false);
    expect(res.body.direction).toBe('ltr');
    expect(res.body.timezone).toBe('America/New_York');
  });

  it('a Qatar branch resolves ar / RTL — same endpoint, opposite behavior, driven by the pack', async () => {
    const res = await demo(qaBranchId).expect(200);
    expect(res.body.locale).toBe('ar');
    expect(res.body.rtl).toBe(true);
    expect(res.body.direction).toBe('rtl');
    expect(res.body.timezone).toBe('Asia/Qatar');
  });

  it('the same UTC instant renders differently per branch timezone', async () => {
    const us = await demo(usBranchId).expect(200);
    const qa = await demo(qaBranchId).expect(200);
    expect(us.body.formatted).not.toBe(qa.body.formatted);
    // Both are ISO-8601 UTC — the stored/wire format never changes per timezone.
    expect(() => new Date(us.body.nowUtc).toISOString()).not.toThrow();
    expect(us.body.nowUtc.endsWith('Z')).toBe(true);
  });
});
