/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) — proves
 * the three caches this step actually ships (country packs, org/branch
 * structure, permissions) over real HTTP against real Redis/Postgres:
 *   - Tenant (and, for permissions, tenant+user) SCOPED keys — one
 *     tenant/user's cached entry can never be served to another.
 *   - Immediate INVALIDATION on the real write path that changes the
 *     underlying data, not just eventual TTL expiry — "stale entitlement
 *     is a security issue, not just a freshness one" extends to these
 *     caches too: a tenant must never keep seeing pre-change data because
 *     a cache happened to still be warm.
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
const TENANT_A_SLUG = 'scaling-test-tenant-a';
const TENANT_B_SLUG = 'scaling-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function csv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitFor: timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

describe('data-layer caching (Phase 5.1, e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;
  let branchBId: string;
  let tokenAdminA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  function server() {
    return app.getHttpServer();
  }
  function get(path: string, token: string, slug: string, query: Record<string, string> = {}) {
    return request(server()).get(path).query(query).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`);
  }
  function put(path: string, token: string, slug: string, body: unknown) {
    return request(server()).put(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function postJson(path: string, token: string, slug: string, body: unknown) {
    return request(server()).post(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function uploadBranchBatch(token: string, slug: string, fileContent: string) {
    return request(server())
      .post('/migration/batches')
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .field('entityType', 'BRANCH')
      .field('fileFormat', 'CSV')
      .field('mode', 'PARTIAL')
      .field('columnMapping', JSON.stringify({ name: 'Branch Name', countryCode: 'Country', timezone: 'TZ' }))
      .attach('file', Buffer.from(fileContent, 'utf-8'), 'data.csv');
  }
  async function waitForBatchStatus(token: string, slug: string, id: string, statuses: string[]) {
    return waitFor(async () => {
      const res = await get(`/migration/batches/${id}`, token, slug);
      return statuses.includes(res.body.status) ? res.body : null;
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Scaling Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Scaling Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Scaling A HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'Scaling B HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchAId = branchA.id;
    branchBId = branchB.id;

    const adminARole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeARole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminBRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await prisma.user.create({ data: { tenantId: tenantAId, email: 'admin@scaling-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeA = await prisma.user.create({ data: { tenantId: tenantAId, email: 'employee@scaling-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeARole.id } });
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({ data: { tenantId: tenantBId, email: 'admin@scaling-b.test', hashedPassword: 'unused', status: 'ACTIVE' } });
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

  describe('country pack cache', () => {
    it('a tenant override takes effect on the VERY NEXT read — invalidation, not a 60s TTL wait', async () => {
      const before = await get('/country-packs/effective/US', tokenAdminA, TENANT_A_SLUG).expect(200);
      const baselineAnnual = before.body.leaveDefaults.annualDays;

      // Warm the cache with the baseline first.
      await get('/country-packs/effective/US', tokenAdminA, TENANT_A_SLUG).expect(200);

      await put('/country-packs/overrides/US', tokenAdminA, TENANT_A_SLUG, {
        leaveDefaults: { annualDays: baselineAnnual + 3, sickDays: 10, maternityDays: 90, paternityDays: 14 },
      }).expect(200);

      const after = await get('/country-packs/effective/US', tokenAdminA, TENANT_A_SLUG).expect(200);
      expect(after.body.leaveDefaults.annualDays).toBe(baselineAnnual + 3);
    });

    it("tenant A's override is never served to tenant B for the same country code — tenant-scoped cache keys", async () => {
      const resB = await get('/country-packs/effective/US', tokenAdminB, TENANT_B_SLUG).expect(200);
      // Tenant B never wrote an override — must still see the PACK'S OWN
      // default, never tenant A's +3 override cached under a shared key.
      expect(resB.body.leaveDefaults.annualDays).not.toBe(undefined);
      const resA = await get('/country-packs/effective/US', tokenAdminA, TENANT_A_SLUG).expect(200);
      expect(resB.body.leaveDefaults.annualDays).not.toBe(resA.body.leaveDefaults.annualDays);
    });
  });

  describe('permissions cache — scoped per (tenant, user), never bled across users in the same tenant', () => {
    it('a TENANT_ADMIN and a plain EMPLOYEE in the SAME tenant get correctly DIFFERENT RBAC outcomes on the same permission-gated route', async () => {
      // country_pack.override.manage: TENANT_ADMIN has it, EMPLOYEE does not.
      await put('/country-packs/overrides/QA', tokenAdminA, TENANT_A_SLUG, {
        leaveDefaults: { annualDays: 25, sickDays: 14, maternityDays: 90, paternityDays: 14 },
      }).expect(200);

      await put('/country-packs/overrides/QA', tokenEmployeeA, TENANT_A_SLUG, {
        leaveDefaults: { annualDays: 30, sickDays: 14, maternityDays: 90, paternityDays: 14 },
      }).expect(403);

      // Re-check the admin immediately after — the employee's 403 must not
      // have somehow poisoned the admin's own cached permission set.
      await put('/country-packs/overrides/QA', tokenAdminA, TENANT_A_SLUG, {
        leaveDefaults: { annualDays: 26, sickDays: 14, maternityDays: 90, paternityDays: 14 },
      }).expect(200);
    });
  });

  describe('org-structure (branch list) cache', () => {
    it("a branch imported via the migration toolkit appears on the VERY NEXT read — invalidation, not a 60s TTL wait", async () => {
      const before = await get('/tenancy/branches', tokenAdminA, TENANT_A_SLUG).expect(200);
      expect(before.body.map((b: { id: string }) => b.id)).toEqual([branchAId]);

      const fileContent = csv([
        ['Branch Name', 'Country', 'TZ'],
        ['Scaling Cache Test Branch', 'US', 'America/Chicago'],
      ]);
      const created = await uploadBranchBatch(tokenAdminA, TENANT_A_SLUG, fileContent).expect(201);
      const batchId = created.body.id;

      await postJson(`/migration/batches/${batchId}/validate`, tokenAdminA, TENANT_A_SLUG, {}).expect(201);
      await waitForBatchStatus(tokenAdminA, TENANT_A_SLUG, batchId, ['DRY_RUN_COMPLETE', 'FAILED']);

      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, TENANT_A_SLUG, {}).expect(201);
      await waitForBatchStatus(tokenAdminA, TENANT_A_SLUG, batchId, ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED']);

      const after = await get('/tenancy/branches', tokenAdminA, TENANT_A_SLUG).expect(200);
      const names = (after.body as { name: string }[]).map((b) => b.name).sort();
      expect(names).toEqual(['Scaling A HQ', 'Scaling Cache Test Branch']);
    }, 20000);

    it("tenant B's branch list is completely unaffected by tenant A's import — tenant-scoped cache keys", async () => {
      const resB = await get('/tenancy/branches', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(resB.body.map((b: { id: string }) => b.id)).toEqual([branchBId]);
    });
  });
});
