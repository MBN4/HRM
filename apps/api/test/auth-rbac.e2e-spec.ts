/**
 * Proves 0.4 (auth + RBAC + branch scoping + field-level permissions) end
 * to end over real HTTP, against local Postgres + Redis — not unit tests of
 * individual services.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'auth-test-tenant-a';
const TENANT_B_SLUG = 'auth-test-tenant-b';
const PASSWORD = 'correct-horse-battery-staple';

const password = new PasswordService();
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('auth + RBAC + branch scoping + field-level permissions (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchA1Id: string;
  let branchA2Id: string;

  let adminAEmail: string;
  let employeeAEmail: string;
  let branchLimitedAEmail: string;
  let adminBEmail: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Auth Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Auth Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'QA', hostingRegion: 'me-south-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchA1 = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Branch 1', countryCode: 'US', timezone: 'America/New_York' },
    });
    const branchA2 = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Branch 2', countryCode: 'US', timezone: 'America/Chicago' },
    });
    branchA1Id = branchA1.id;
    branchA2Id = branchA2.id;

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const employeeARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const hashedPassword = await password.hash(PASSWORD);

    adminAEmail = 'admin@a.test';
    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: adminAEmail, hashedPassword, status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });

    employeeAEmail = 'employee@a.test';
    const employeeA = await prisma.user.create({
      data: { tenantId: tenantAId, email: employeeAEmail, hashedPassword, status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeARole.id } });

    branchLimitedAEmail = 'branchlimited@a.test';
    const branchLimitedA = await prisma.user.create({
      data: { tenantId: tenantAId, email: branchLimitedAEmail, hashedPassword, status: 'ACTIVE' },
    });
    await prisma.userRole.create({
      data: { tenantId: tenantAId, userId: branchLimitedA.id, roleId: employeeARole.id },
    });
    await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: branchLimitedA.id, branchId: branchA1Id } });

    adminBEmail = 'admin@b.test';
    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: adminBEmail, hashedPassword, status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await redis.quit();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function login(tenantSlug: string, email: string, pw = PASSWORD) {
    return request(app.getHttpServer()).post('/auth/login').set('Host', hostFor(tenantSlug)).send({ email, password: pw });
  }

  describe('login', () => {
    it('succeeds with correct credentials and returns roles/permissions', async () => {
      const res = await login(TENANT_A_SLUG, adminAEmail).expect(200);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.roles).toEqual([SYSTEM_ROLES.TENANT_ADMIN]);
      expect(res.body.permissions).toEqual(expect.arrayContaining(['salary.view', 'role.manage']));
    });

    it('rejects a wrong password with a generic message', async () => {
      const res = await login(TENANT_A_SLUG, adminAEmail, 'wrong-password').expect(401);
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('rejects an unknown email with the SAME generic message (no enumeration)', async () => {
      const res = await login(TENANT_A_SLUG, 'nobody@a.test', 'whatever').expect(401);
      expect(res.body.message).toBe('Invalid email or password.');
    });
  });

  describe('refresh rotation + reuse detection', () => {
    it('rotates on refresh, then detects reuse of the old token and revokes the whole family', async () => {
      const loginRes = await login(TENANT_A_SLUG, adminAEmail).expect(200);
      const originalRefreshToken = loginRes.body.refreshToken as string;

      const refreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: originalRefreshToken })
        .expect(200);
      const rotatedRefreshToken = refreshRes.body.refreshToken as string;
      expect(rotatedRefreshToken).not.toBe(originalRefreshToken);

      // Reusing the already-rotated-away token is the signature of a stolen
      // refresh token — must be rejected AND revoke the whole family.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: originalRefreshToken })
        .expect(401);

      // The legitimately-rotated token must ALSO now be dead — reuse
      // detection revokes the entire family, not just the reused token.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: rotatedRefreshToken })
        .expect(401);
    });
  });

  describe('logout / logout-all', () => {
    it('logout revokes only that session, leaving other sessions valid', async () => {
      const sessionOne = (await login(TENANT_A_SLUG, employeeAEmail)).body;
      const sessionTwo = (await login(TENANT_A_SLUG, employeeAEmail)).body;

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${sessionOne.accessToken}`)
        .send({ refreshToken: sessionOne.refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: sessionOne.refreshToken })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: sessionTwo.refreshToken })
        .expect(200);
    });

    it('logout-all revokes every session for the user', async () => {
      const sessionOne = (await login(TENANT_A_SLUG, employeeAEmail)).body;
      const sessionTwo = (await login(TENANT_A_SLUG, employeeAEmail)).body;

      await request(app.getHttpServer())
        .post('/auth/logout-all')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${sessionOne.accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: sessionOne.refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: sessionTwo.refreshToken })
        .expect(401);
    });
  });

  describe('RBAC', () => {
    it('allows a user holding the required permission', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, adminAEmail)).body;
      await request(app.getHttpServer())
        .get('/auth/rbac-demo')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('rejects a user missing the required permission with 403', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, employeeAEmail)).body;
      await request(app.getHttpServer())
        .get('/auth/rbac-demo')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('field-level permissions', () => {
    it('includes the gated field for a user holding the permission', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, adminAEmail)).body;
      const res = await request(app.getHttpServer())
        .get('/tenancy/permission-field-demo')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('salary', 95000);
      expect(res.body).toMatchObject({ id: 'demo-1', name: 'Jane Doe', department: 'Engineering' });
    });

    it('OMITS (not nulls) the gated field for a user lacking the permission', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, employeeAEmail)).body;
      const res = await request(app.getHttpServer())
        .get('/tenancy/permission-field-demo')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).not.toHaveProperty('salary');
      expect(res.body).toMatchObject({ id: 'demo-1', name: 'Jane Doe', department: 'Engineering' });
    });
  });

  describe('branch scoping', () => {
    it('limits a branch-restricted user to their branch(es) only', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, branchLimitedAEmail)).body;
      const res = await request(app.getHttpServer())
        .get('/tenancy/branches')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchA1Id]);
    });

    it('an unrestricted user sees every branch in the tenant', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, adminAEmail)).body;
      const res = await request(app.getHttpServer())
        .get('/tenancy/branches')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.map((b: { id: string }) => b.id).sort()).toEqual([branchA1Id, branchA2Id].sort());
    });
  });

  describe('cross-tenant isolation', () => {
    it('cannot log in to a tenant the account does not belong to', async () => {
      const res = await login(TENANT_B_SLUG, adminAEmail).expect(401);
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('rejects a token minted for tenant A when the request resolves to tenant B', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, adminAEmail)).body;
      await request(app.getHttpServer())
        .get('/tenancy/whoami')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('RLS still holds: tenant A admin never sees tenant B branches', async () => {
      const { accessToken } = (await login(TENANT_A_SLUG, adminAEmail)).body;
      const res = await request(app.getHttpServer())
        .get('/tenancy/branches')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.every((b: { id: string }) => b.id === branchA1Id || b.id === branchA2Id)).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('throttles repeated failed logins for the same account', async () => {
      const rateLimitedEmail = 'ratelimit-target@a.test';
      await redis.del(`ratelimit:login:${tenantAId}:${rateLimitedEmail}`);

      let lastStatus = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- must be sequential to exercise the counter in order
        const res = await login(TENANT_A_SLUG, rateLimitedEmail, 'wrong-password');
        lastStatus = res.status;
      }

      expect(lastStatus).toBe(429);
    });
  });
});
