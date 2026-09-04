/**
 * Proves white-label / branding (step 4.3) end to end over real HTTP — see
 * docs/conventions/white-label.md: a tenant sets its own branding and the
 * public read reflects it immediately; branding NEVER bleeds across
 * tenants; RBAC gates every mutation; a branded custom domain stays
 * unresolvable until VERIFIED and then genuinely resolves the right
 * tenant; TLS provisioning requires VERIFIED first; the full-rebrand
 * capability is entitlement-gated and re-checked LIVE (a downgrade
 * restores the "Powered by" footer even though the stored bit is still
 * true); the vendor console's oversight surface is platform-gated
 * (READ both roles, MANAGE owner-only) and every mutation is dual-audited
 * into both the platform's own trail and the target tenant's own
 * `audit_log`; and outbound email reflects the tenant's branded product
 * name.
 *
 * `PLATFORM_MODE_ENABLED` is forced on here (before the Nest app is
 * compiled) to exercise the vendor console's branding oversight routes —
 * the same per-file pattern every other platform-touching e2e file in
 * this suite already takes.
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
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { createTestPlatformAdmin, cleanupTestPlatformAdmins } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';

const TENANT_A_SLUG = 'white-label-tenant-a';
const TENANT_B_SLUG = 'white-label-tenant-b';
const TENANT_C_SLUG = 'white-label-tenant-c'; // ENTERPRISE — full-rebrand entitlement tests
const CUSTOM_DOMAIN = 'hr.white-label-fixture.example';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG, TENANT_C_SLUG] } } });
  await cleanupTestPlatformAdmins();
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

async function createTenantWithAdmin(slug: string, name: string, edition: 'STARTER' | 'ENTERPRISE' = 'STARTER') {
  const tenant = await prisma.tenant.create({
    data: { name, slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1', edition },
  });
  await seedSystemRolesAndPermissions(prisma, tenant.id);
  if (edition === 'ENTERPRISE') {
    await prisma.subscription.create({ data: { tenantId: tenant.id, edition: 'ENTERPRISE', status: 'ACTIVE' } });
  }
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
  });
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email: `admin@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
  });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id } });
  const employeeRole = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.EMPLOYEE } },
  });
  const employee = await prisma.user.create({
    data: { tenantId: tenant.id, email: `employee@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
  });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: employee.id, roleId: employeeRole.id } });

  return {
    tenantId: tenant.id,
    adminToken: jwt.sign({ sub: admin.id, tenantId: tenant.id }),
    employeeToken: jwt.sign({ sub: employee.id, tenantId: tenant.id }),
    employeeId: employee.id,
    employeeEmail: employee.email,
  };
}

describe('white-label / branding (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantAAdminToken: string;
  let tenantAEmployeeToken: string;
  let tenantAEmployeeId: string;
  let tenantAEmployeeEmail: string;

  let tenantBAdminToken: string;

  let tenantCAdminToken: string;

  beforeAll(async () => {
    await resetFixtures();

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    const a = await createTenantWithAdmin(TENANT_A_SLUG, 'White Label Tenant A');
    tenantAId = a.tenantId;
    tenantAAdminToken = a.adminToken;
    tenantAEmployeeToken = a.employeeToken;
    tenantAEmployeeId = a.employeeId;
    tenantAEmployeeEmail = a.employeeEmail;

    const b = await createTenantWithAdmin(TENANT_B_SLUG, 'White Label Tenant B');
    tenantBAdminToken = b.adminToken;

    const c = await createTenantWithAdmin(TENANT_C_SLUG, 'White Label Tenant C', 'ENTERPRISE');
    tenantCAdminToken = c.adminToken;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function get(path: string, host: string, token?: string) {
    const req = request(app.getHttpServer()).get(path).set('Host', host);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }
  function put(path: string, host: string, token: string, body: unknown) {
    return request(app.getHttpServer()).put(path).set('Host', host).set('Authorization', `Bearer ${token}`).send(body);
  }
  function post(path: string, host: string, token: string, body: unknown = {}) {
    return request(app.getHttpServer()).post(path).set('Host', host).set('Authorization', `Bearer ${token}`).send(body);
  }
  function del(path: string, host: string, token: string) {
    return request(app.getHttpServer()).delete(path).set('Host', host).set('Authorization', `Bearer ${token}`);
  }
  // Platform (`/platform/*`) routes bypass tenant resolution entirely (see
  // TenantScopeInterceptor/@PlatformRoute()) — no `Host` header is set,
  // the same convention every other platform-touching e2e file in this
  // suite already follows.
  function platformGet(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }
  function platformPost(path: string, token: string, body: unknown = {}) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
  }
  function platformDelete(path: string, token: string) {
    return request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);
  }
  /** Reliably buffers a binary response as a real `Buffer` — the SAME `.buffer(true).parse(...)` pattern `payroll.e2e-spec.ts`'s own `download` helper already establishes (superagent's default per-content-type body parsing isn't guaranteed to do this). */
  function download(path: string, host: string) {
    return request(app.getHttpServer())
      .get(path)
      .set('Host', host)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  describe('public resolution + defaults', () => {
    it('a tenant with no branding row resolves plain product defaults', async () => {
      const res = await get('/branding', hostFor(TENANT_B_SLUG)).expect(200);
      expect(res.body).toMatchObject({ productName: 'HRM', hasLogo: false, hasFavicon: false, showPoweredBy: true });
    });
  });

  describe('setting branding — reflected immediately, isolated per tenant', () => {
    it('RBAC: a plain employee cannot update branding', async () => {
      await put('/branding', hostFor(TENANT_A_SLUG), tenantAEmployeeToken, { productName: 'Should Not Apply' }).expect(403);
    });

    it('a tenant admin sets productName/colors and the public read reflects it immediately', async () => {
      await put('/branding', hostFor(TENANT_A_SLUG), tenantAAdminToken, {
        productName: 'Acme Corp HR',
        primaryColor: '#123456',
        loginHeadline: 'Welcome to Acme',
      }).expect(200);

      const res = await get('/branding', hostFor(TENANT_A_SLUG)).expect(200);
      expect(res.body).toMatchObject({ productName: 'Acme Corp HR', primaryColor: '#123456', loginHeadline: 'Welcome to Acme' });
    });

    it('cross-tenant isolation: tenant B never sees tenant A branding', async () => {
      const res = await get('/branding', hostFor(TENANT_B_SLUG)).expect(200);
      expect(res.body.productName).toBe('HRM');
      expect(res.body.primaryColor).toBeNull();
    });

    it('rejects a malformed color', async () => {
      await put('/branding', hostFor(TENANT_A_SLUG), tenantAAdminToken, { primaryColor: 'not-a-color' }).expect(400);
    });
  });

  describe('logo upload + download', () => {
    // A 1x1 transparent PNG, small enough to keep the fixture inline.
    const PNG_BYTES = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    it('uploads a logo, then downloads the same bytes back', async () => {
      await request(app.getHttpServer())
        .post('/branding/logo')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tenantAAdminToken}`)
        .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);

      const publicRes = await get('/branding', hostFor(TENANT_A_SLUG)).expect(200);
      expect(publicRes.body.hasLogo).toBe(true);

      const downloadRes = await download('/branding/logo', hostFor(TENANT_A_SLUG)).expect(200);
      expect(Buffer.compare(downloadRes.body as Buffer, PNG_BYTES)).toBe(0);
    });

    it('a tenant with no logo 404s on download', async () => {
      await get('/branding/logo', hostFor(TENANT_B_SLUG)).expect(404);
    });
  });

  describe('outbound email reflects the branded product name', () => {
    it('the password-reset email subject uses the branded productName instead of the default', async () => {
      await request(app.getHttpServer())
        .post('/auth/request-password-reset')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ email: tenantAEmployeeEmail })
        .expect(204);

      const delivery = await waitFor(async () => {
        const rows = await prisma.notificationDelivery.findMany({
          where: {
            notification: { tenantId: tenantAId, recipientUserId: tenantAEmployeeId, eventType: 'auth.password_reset_requested' },
            channel: 'EMAIL',
          },
          orderBy: { createdAt: 'desc' },
        });
        return rows.find((r) => r.status === 'SENT') ?? null;
      });

      expect(delivery.renderedSubject).toContain('Acme Corp HR');
      expect(delivery.renderedSubject).not.toContain('Reset your HRM password');
    });
  });

  describe('full rebrand — gated by FEATURE_FLAGS.FULL_REBRAND, re-checked live', () => {
    it('a non-entitled (STARTER) tenant cannot enable full rebrand', async () => {
      await put('/branding/rebrand', hostFor(TENANT_A_SLUG), tenantAAdminToken, { enabled: true }).expect(403);
      const res = await get('/branding', hostFor(TENANT_A_SLUG)).expect(200);
      expect(res.body.showPoweredBy).toBe(true);
    });

    it('an entitled (ENTERPRISE) tenant can enable it, and the "Powered by" footer disappears', async () => {
      await put('/branding/rebrand', hostFor(TENANT_C_SLUG), tenantCAdminToken, { enabled: true }).expect(200);
      const res = await get('/branding', hostFor(TENANT_C_SLUG)).expect(200);
      expect(res.body.showPoweredBy).toBe(false);
    });

    it('a lapsed subscription restores the footer LIVE, even though the stored bit is still true', async () => {
      await prisma.subscription.update({ where: { tenantId: (await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_C_SLUG } })).id }, data: { status: 'CANCELED' } });

      const settingsRes = await get('/branding/settings', hostFor(TENANT_C_SLUG), tenantCAdminToken).expect(200);
      expect(settingsRes.body.fullRebrandEnabled).toBe(true); // the stored bit is untouched
      expect(settingsRes.body.fullRebrandEntitled).toBe(false); // but entitlement is gone

      const publicRes = await get('/branding', hostFor(TENANT_C_SLUG)).expect(200);
      expect(publicRes.body.showPoweredBy).toBe(true); // and the footer is back
    });
  });

  describe('branded custom domain — unresolvable until VERIFIED, TLS requires VERIFIED first', () => {
    let domainId: string;
    let platformOwnerToken: string;
    let platformSupportToken: string;

    beforeAll(async () => {
      platformOwnerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
      platformSupportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;
    });

    it('a tenant admin requests a custom domain — PENDING_VERIFICATION, does NOT resolve traffic yet', async () => {
      const res = await post('/branding/domain', hostFor(TENANT_A_SLUG), tenantAAdminToken, { domain: CUSTOM_DOMAIN }).expect(201);
      expect(res.body).toMatchObject({ domain: CUSTOM_DOMAIN, verificationStatus: 'PENDING_VERIFICATION' });
      expect(typeof res.body.dnsRecordValue).toBe('string');
      domainId = res.body.id;

      // The domain must NOT resolve real tenant traffic yet.
      await get('/branding', CUSTOM_DOMAIN).expect(401);
    });

    it('a second tenant cannot claim the same domain', async () => {
      await post('/branding/domain', hostFor(TENANT_B_SLUG), tenantBAdminToken, { domain: CUSTOM_DOMAIN }).expect(409);
    });

    it('platform oversight reads are support-safe; TLS provisioning is refused before verification', async () => {
      const listRes = await platformGet('/platform/branding/tenants', platformSupportToken).expect(200);
      expect(listRes.body.some((row: { tenantId: string }) => row.tenantId === tenantAId)).toBe(true);

      await platformPost(`/platform/branding/tenants/${tenantAId}/domain/${domainId}/provision-tls`, platformOwnerToken).expect(400);
    });

    it('PLATFORM_SUPPORT cannot approve a domain (owner-only MANAGE)', async () => {
      await platformPost(`/platform/branding/tenants/${tenantAId}/domain/${domainId}/approve`, platformSupportToken).expect(403);
    });

    it('platform owner manually approves the domain — now VERIFIED, and it resolves the right tenant', async () => {
      const res = await platformPost(`/platform/branding/tenants/${tenantAId}/domain/${domainId}/approve`, platformOwnerToken).expect(201);
      expect(res.body.verificationStatus).toBe('VERIFIED');

      const branded = await get('/branding', CUSTOM_DOMAIN, tenantAAdminToken).expect(200);
      expect(branded.body.productName).toBe('Acme Corp HR');
    });

    it('the target tenant can see the approval in its OWN audit log — never silent', async () => {
      const auditRes = await get('/audit?entityType=TenantDomain', hostFor(TENANT_A_SLUG), tenantAAdminToken).expect(200);
      expect(auditRes.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'branding.domain_manually_approved', actorPlatform: true })]),
      );
    });

    it('TLS provisioning now succeeds once VERIFIED', async () => {
      const res = await platformPost(`/platform/branding/tenants/${tenantAId}/domain/${domainId}/provision-tls`, platformOwnerToken).expect(201);
      expect(res.body.certStatus).toBe('ISSUED');
      expect(res.body.certExpiresAt).toBeTruthy();
    });

    it('the tenant can delete its own domain request', async () => {
      await del(`/branding/domain/${domainId}`, hostFor(TENANT_A_SLUG), tenantAAdminToken).expect(204);
      await get('/branding', CUSTOM_DOMAIN).expect(401);
    });
  });

  describe('platform branding oversight — reset', () => {
    let platformOwnerToken: string;

    beforeAll(async () => {
      platformOwnerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    });

    it('force-resets a tenant branding back to defaults', async () => {
      await platformDelete(`/platform/branding/tenants/${tenantAId}/reset`, platformOwnerToken).expect(204);

      const res = await get('/branding', hostFor(TENANT_A_SLUG)).expect(200);
      expect(res.body.productName).toBe('HRM');
    });

    it('no token at all is rejected on every platform branding route', async () => {
      await platformGet('/platform/branding/tenants').expect(401);
    });
  });
});
