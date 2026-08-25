/**
 * Proves the Country Pack system (0.5) end to end over real HTTP, against
 * local Postgres — the same requirement 0.2-0.4's e2e suites hold
 * themselves to: this is not a test of the merge/evaluator functions in
 * isolation (see the rules-engine unit specs under
 * apps/api/src/country-packs/rules-engine/), it's a test that the SAME
 * code path (`GET /country-packs/effective`) produces genuinely different,
 * data-driven behavior for a US branch vs. a Qatar branch, that the
 * two-layer tenant override model actually layers and bounds-checks, and
 * that a tenant's override cannot leak across to another tenant (RLS).
 *
 * A JWT is minted directly here (bypassing the real login flow, which is
 * exercised in full by auth-rbac.e2e-spec.ts) — this file's concern is
 * country packs, not auth, same rationale tenant-resolution.e2e-spec.ts
 * documents for doing the same thing.
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
const TENANT_A_SLUG = 'cp-test-tenant-a';
const TENANT_B_SLUG = 'cp-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('country packs (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAUsId: string;
  let branchAQaId: string;
  let branchAUnsupportedId: string;
  let branchBQaId: string;

  let tokenAdminA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Country Pack Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Country Pack Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'QA', hostingRegion: 'me-south-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchAUs = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A US HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    const branchAQa = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    const branchAUnsupported = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Unsupported Country Office', countryCode: 'ZZ', timezone: 'UTC' },
    });
    branchAUsId = branchAUs.id;
    branchAQaId = branchAQa.id;
    branchAUnsupportedId = branchAUnsupported.id;

    const branchBQa = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'B Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchBQaId = branchBQa.id;

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const employeeARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@cp-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'employee@cp-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeARole.id } });
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@cp-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function getEffective(tenantSlug: string, token: string, branchId: string) {
    return request(app.getHttpServer())
      .get('/country-packs/effective')
      .query({ branchId })
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`);
  }

  function putOverride(tenantSlug: string, token: string, countryCode: string, body: unknown) {
    return request(app.getHttpServer())
      .put(`/country-packs/overrides/${countryCode}`)
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  describe('same code path, divergent behavior driven entirely by data', () => {
    it('a US branch resolves USD / Sat-Sun weekend / multi-layer federal+state+FICA tax / SSN+W4 required', async () => {
      const res = await getEffective(TENANT_A_SLUG, tokenAdminA, branchAUsId).expect(200);

      expect(res.body.locale.currencyCode).toBe('USD');
      expect(res.body.locale.rtl).toBe(false);
      expect(res.body.workingTime.weekendDays.slice().sort()).toEqual(['SATURDAY', 'SUNDAY']);
      expect(res.body.tax.layers.map((l: { name: string }) => l.name)).toEqual([
        'federal_income_tax',
        'state_income_tax',
        'fica_social_security',
        'fica_medicare',
      ]);
      expect(res.body.requiredEmployeeFields).toEqual(['SSN', 'W4']);
      expect(res.body.payrollMode).toBe('CALCULATE');
    });

    it('a QA branch resolves QAR / Fri-Sat weekend / no income tax / end-of-service gratuity / QatarID+visa required', async () => {
      const res = await getEffective(TENANT_A_SLUG, tokenAdminA, branchAQaId).expect(200);

      expect(res.body.locale.currencyCode).toBe('QAR');
      expect(res.body.locale.rtl).toBe(true);
      expect(res.body.workingTime.weekendDays.slice().sort()).toEqual(['FRIDAY', 'SATURDAY']);
      expect(res.body.tax.layers).toEqual([]);
      expect(res.body.statutory.components.map((c: { name: string }) => c.name)).toEqual(['end_of_service_gratuity']);
      expect(res.body.requiredEmployeeFields).toEqual(['QATAR_ID', 'VISA_SPONSORSHIP']);
    });

    it('a branch in a country with no active pack fails loudly (404), not with a silent generic default', async () => {
      await getEffective(TENANT_A_SLUG, tokenAdminA, branchAUnsupportedId).expect(404);
    });
  });

  describe('two-layer tenant override', () => {
    it('QA leave defaults start at the pack legal floor (21 days) before any override exists', async () => {
      const res = await getEffective(TENANT_A_SLUG, tokenAdminA, branchAQaId).expect(200);
      expect(res.body.leaveDefaults.annualDays).toBe(21);
    });

    it('a tenant admin can grant MORE than the legal floor, and it layers over the pack default', async () => {
      const putRes = await putOverride(TENANT_A_SLUG, tokenAdminA, 'QA', { leaveDefaults: { annualDays: 25 } }).expect(
        200,
      );
      expect(putRes.body.leaveDefaults.annualDays).toBe(25);
      // Untouched sections still come straight from the pack.
      expect(putRes.body.leaveDefaults.sickDays).toBe(14);
      expect(putRes.body.statutory.components.map((c: { name: string }) => c.name)).toEqual([
        'end_of_service_gratuity',
      ]);

      const getRes = await getEffective(TENANT_A_SLUG, tokenAdminA, branchAQaId).expect(200);
      expect(getRes.body.leaveDefaults.annualDays).toBe(25);
    });

    it('rejects an override that would drop leave below the pack legal floor', async () => {
      const res = await putOverride(TENANT_A_SLUG, tokenAdminA, 'QA', { leaveDefaults: { annualDays: 15 } }).expect(400);
      expect(res.body.message).toMatch(/legal floor/);
    });

    it('rejects an override touching a non-overridable section (tax/statutory/locale are legal, not tenant-adjustable)', async () => {
      await putOverride(TENANT_A_SLUG, tokenAdminA, 'QA', { tax: { layers: [] } }).expect(400);
    });

    it('denies a caller without country_pack.override.manage (deny-by-default RBAC)', async () => {
      await putOverride(TENANT_A_SLUG, tokenEmployeeA, 'QA', { leaveDefaults: { annualDays: 25 } }).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security on tenant_country_overrides)', () => {
    it("tenant A's override for QA does not leak into tenant B's resolution of the same country", async () => {
      // Tenant A's override (annualDays: 25) was written in the previous describe block.
      const res = await getEffective(TENANT_B_SLUG, tokenAdminB, branchBQaId).expect(200);
      expect(res.body.leaveDefaults.annualDays).toBe(21);
    });
  });
});
