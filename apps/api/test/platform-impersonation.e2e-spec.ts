/**
 * Proves impersonation + cross-tenant audit read (step 4.1) end to end
 * over real HTTP — see docs/conventions/vendor-console.md → Impersonation:
 *   - Works: the minted token authenticates as the target tenant user
 *     against an ORDINARY tenant route.
 *   - Time-boxed: the server-side cap applies regardless of what's
 *     requested, and the session row (not just the token's own `exp`) is
 *     what's actually checked — an externally-expired session (its
 *     `expiresAt` in the past) stops authenticating immediately, and an
 *     ended session does too.
 *   - LOUDLY audited, never silent: session start/end land in the TARGET
 *     TENANT'S OWN `audit_log` (visible to that tenant's own `GET /audit`)
 *     AND in the platform's own cross-tenant trail; every action taken
 *     WHILE impersonating is tagged with the REAL platform admin's id in
 *     that same tenant audit_log entry's metadata.
 *   - Cannot impersonate into a suspended tenant or an inactive user.
 *   - Ending someone ELSE's session requires the separate, higher-bar
 *     revoke path (ADMIN_MANAGE); self-ending doesn't.
 *   - Cross-tenant audit reads are themselves gated + audited.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'platform-impersonation-tenant';

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
  await cleanupTestPlatformAdmins();
}

describe('platform impersonation + cross-tenant audit (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let ownerToken: string;
  let ownerId: string;
  let supportToken: string;
  let tenantId: string;
  let targetUserId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    const owner = await createTestPlatformAdmin('PLATFORM_OWNER');
    ownerToken = owner.token;
    ownerId = owner.id;
    supportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;

    const tenant = await prisma.tenant.create({
      data: { name: 'Impersonation Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'target@impersonation-tenant.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    targetUserId = user.id;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('starts a session, and the minted token authenticates as the target user against an ordinary tenant route', async () => {
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'customer asked for help debugging leave balances' })
      .expect(201);

    expect(started.body.session.tenantId).toBe(tenantId);
    expect(started.body.session.targetUserId).toBe(targetUserId);
    expect(typeof started.body.accessToken).toBe('string');

    const whoami = await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .expect(200);
    expect(whoami.body.userId).toBe(targetUserId);
  });

  it('caps duration server-side regardless of what was requested', async () => {
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'testing the duration cap', durationMinutes: 120 })
      .expect(201);

    const expiresAt = new Date(started.body.session.expiresAt).getTime();
    const startedAt = new Date(started.body.session.startedAt).getTime();
    // MAX_IMPERSONATION_MINUTES = 60, strictly less than the requested 120.
    expect(expiresAt - startedAt).toBeLessThanOrEqual(60 * 60_000 + 5_000);
  });

  it('is LOUDLY audited: session start lands in the TENANT\'s own audit_log with actorPlatform:true, AND every action taken while impersonating is tagged with the real platform admin', async () => {
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'auditing this impersonation session' })
      .expect(201);

    const startEntry = await prisma.auditLog.findFirst({
      where: { tenantId, action: 'platform.impersonation.started', entityId: started.body.session.id },
    });
    expect(startEntry).not.toBeNull();
    expect(startEntry!.actorPlatform).toBe(true);
    expect(startEntry!.metadata).toMatchObject({ platformAdminId: ownerId, targetUserId });

    // A real mutation performed WHILE impersonating — country-pack
    // override write is @AuditLog()'d and TENANT_ADMIN holds
    // country_pack.override.manage via ALL_PERMISSIONS.
    await request(app.getHttpServer())
      .put('/country-packs/overrides/US')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .send({ leaveDefaults: { annualDays: 22 } })
      .expect(200);

    const mutationEntry = await prisma.auditLog.findFirst({
      where: { tenantId, entityType: 'TenantCountryOverride', action: 'UPDATE' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(mutationEntry!.actorUserId).toBe(targetUserId);
    expect(mutationEntry!.metadata).toMatchObject({ impersonatedByPlatformAdminId: ownerId });
  });

  it('the session row is the source of truth — an externally-expired session stops authenticating immediately', async () => {
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'testing expiry enforcement' })
      .expect(201);

    await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .expect(200);

    await prisma.impersonationSession.update({
      where: { id: started.body.session.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .expect(401);
  });

  it('ending your own session revokes the token immediately, and is itself audited', async () => {
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'testing self-end' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/platform/impersonation/sessions/${started.body.session.id}/end`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .expect(401);

    const endEntry = await prisma.auditLog.findFirst({
      where: { tenantId, action: 'platform.impersonation.ended', entityId: started.body.session.id },
    });
    expect(endEntry).not.toBeNull();
  });

  it("cannot end ANOTHER admin's session via /end — only via the separate, owner-only /revoke", async () => {
    const support = await createTestPlatformAdmin('PLATFORM_SUPPORT');
    const started = await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'testing revoke boundary' })
      .expect(201);

    // A different platform admin cannot end this session via /end (not the owner).
    await request(app.getHttpServer())
      .post(`/platform/impersonation/sessions/${started.body.session.id}/end`)
      .set('Authorization', `Bearer ${support.token}`)
      .expect(403);

    // PLATFORM_SUPPORT also lacks ADMIN_MANAGE, so /revoke is denied too.
    await request(app.getHttpServer())
      .post(`/platform/impersonation/sessions/${started.body.session.id}/revoke`)
      .set('Authorization', `Bearer ${support.token}`)
      .expect(403);

    // A SECOND owner CAN revoke it, via the dedicated route.
    const owner2 = await createTestPlatformAdmin('PLATFORM_OWNER');
    await request(app.getHttpServer())
      .post(`/platform/impersonation/sessions/${started.body.session.id}/revoke`)
      .set('Authorization', `Bearer ${owner2.token}`)
      .expect(201);

    await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${started.body.accessToken}`)
      .expect(401);
  });

  it('cannot impersonate a user in a SUSPENDED tenant', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId, reason: 'should be blocked' })
      .expect(403);
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
  });

  it('cannot impersonate an INACTIVE user', async () => {
    const inactive = await prisma.user.create({
      data: { tenantId, email: 'inactive@impersonation-tenant.test', hashedPassword: 'unused', status: 'DISABLED' },
    });
    await request(app.getHttpServer())
      .post(`/platform/impersonation/tenants/${tenantId}/sessions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: inactive.id, reason: 'should be blocked' })
      .expect(403);
  });

  describe('cross-tenant audit read — gated + audited', () => {
    it("PLATFORM_SUPPORT (holds AUDIT_READ) can read the tenant's own audit_log cross-tenant, and the read itself is logged", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/audit/tenant/${tenantId}`)
        .set('Authorization', `Bearer ${supportToken}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const readEntry = await prisma.platformAuditLog.findFirst({
        where: { action: 'platform.audit.tenant_log_read', targetTenantId: tenantId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(readEntry).not.toBeNull();
    });

    it("reads the platform's own cross-tenant audit log, filterable by targetTenantId", async () => {
      const res = await request(app.getHttpServer())
        .get('/platform/audit')
        .query({ targetTenantId: tenantId })
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.some((row: { action: string }) => row.action === 'platform.impersonation.started')).toBe(true);
    });

    it('a caller with no platform token cannot read any audit trail', async () => {
      await request(app.getHttpServer()).get(`/platform/audit/tenant/${tenantId}`).expect(401);
      await request(app.getHttpServer()).get('/platform/audit').expect(401);
    });
  });
});
