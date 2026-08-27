/**
 * Proves the audit log (0.9) end to end over real HTTP — see /CLAUDE.md §
 * Conventions → Audit log:
 *   - An `@AuditLog()`-decorated HTTP mutation (`PUT
 *     /country-packs/overrides/:countryCode`) writes an `audit_log` row
 *     automatically, with no hand-written write in that route.
 *   - An existing domain event (`licensing.revoked`) lands in the trail via
 *     `DomainEventAuditListener`, with no change to `LicensingAdminService`.
 *   - A payload carrying a sensitive field (`auth.password_reset_requested`'s
 *     `token`) is redacted before it ever reaches the row.
 *   - `GET /audit` is deny-by-default (`audit.read`) and tenant-isolated
 *     (RLS) — a TENANT_ADMIN in tenant B never sees tenant A's entries.
 *
 * `PLATFORM_MODE_ENABLED` is forced on (before the Nest app is compiled)
 * purely to exercise the platform-admin licensing revoke endpoint that
 * emits `licensing.revoked` — jest runs each test file in its own worker
 * process, so this doesn't affect other suites' default-off assertions
 * (same pattern `licensing-saas.e2e-spec.ts` already uses).
 *
 * A JWT is minted directly (bypassing the real login flow, exercised in
 * full by auth-rbac.e2e-spec.ts) — same rationale every other e2e suite in
 * this codebase already documents for doing the same thing.
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
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'audit-test-tenant-a';
const TENANT_B_SLUG = 'audit-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 6000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('audit log (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;

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
      data: { name: 'Audit Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Audit Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const adminRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminRoleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@audit-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminRoleA.id } });
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'employee@audit-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeRoleA.id } });
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@audit-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminRoleB.id } });
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('automatic HTTP-mutation capture', () => {
    it('PUT /country-packs/overrides/:countryCode writes an audit row with no hand-written write in that route', async () => {
      await request(app.getHttpServer())
        .put('/country-packs/overrides/US')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ leaveDefaults: { annualDays: 30 } })
        .expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { tenantId: tenantAId, entityType: 'TenantCountryOverride', action: 'UPDATE' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0];
      expect(row.actorPlatform).toBe(false);
      expect(typeof row.actorUserId).toBe('string');
      // First write for this tenant+country -> no prior override -> before is DB NULL.
      expect(row.before).toBeNull();
      expect(row.after).not.toBeNull();
      expect(row.metadata).toMatchObject({ method: 'PUT' });
    });

    it('a second PUT captures the PRIOR override as `before`', async () => {
      await request(app.getHttpServer())
        .put('/country-packs/overrides/US')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ leaveDefaults: { annualDays: 35 } })
        .expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { tenantId: tenantAId, entityType: 'TenantCountryOverride', action: 'UPDATE' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      });
      expect(rows[0].before).toMatchObject({ leaveDefaults: { annualDays: 30 } });
    });
  });

  describe('domain-event capture', () => {
    it('licensing.revoked (emitted by the platform admin route) lands in the trail', async () => {
      await request(app.getHttpServer())
        .post('/platform/licensing/revoke')
        .send({ tenantId: tenantAId, reason: 'audit e2e proof' })
        .expect(201);

      const row = await waitFor(async () => {
        const found = await prisma.auditLog.findFirst({
          where: { tenantId: tenantAId, action: 'licensing.revoked' },
        });
        return found;
      });
      expect(row.entityType).toBe('Licensing');
      expect(row.actorPlatform).toBe(true);
      expect(row.actorUserId).toBeNull();
      expect(row.after).toMatchObject({ type: 'licensing.revoked', reason: 'audit e2e proof' });
    });
  });

  describe('secrets are redacted before ever reaching the row', () => {
    it('auth.password_reset_requested\'s sensitive `token` field never appears un-redacted', async () => {
      const user = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'redact-check@audit-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });

      await request(app.getHttpServer())
        .post('/auth/request-password-reset')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ email: user.email })
        .expect(204);

      const row = await waitFor(async () =>
        prisma.auditLog.findFirst({ where: { tenantId: tenantAId, action: 'auth.password_reset_requested' } }),
      );
      const after = row.after as Record<string, unknown>;
      expect(after.token).toBe('[REDACTED]');
      expect(after.email).toBe(user.email);
    });
  });

  describe('GET /audit — deny-by-default + tenant-isolated', () => {
    it('rejects a caller without audit.read', async () => {
      await request(app.getHttpServer())
        .get('/audit')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenEmployeeA}`)
        .expect(403);
    });

    it('a TENANT_ADMIN can read the tenant\'s own entries', async () => {
      const res = await request(app.getHttpServer())
        .get('/audit')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('tenant B never sees tenant A\'s entries, even filtered by tenant A\'s own entityType', async () => {
      const res = await request(app.getHttpServer())
        .get('/audit')
        .query({ entityType: 'TenantCountryOverride' })
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenAdminB}`)
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
