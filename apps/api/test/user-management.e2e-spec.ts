/**
 * Proves step 7.1 (tenant user / team access management + the forced
 * first-login password change) end to end over real HTTP against local
 * Postgres + Redis. See docs/conventions/user-management.md.
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
import { configureSecurity } from '../src/security/configure-security';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'usermgmt-tenant-a';
const SLUG_B = 'usermgmt-tenant-b';
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'brand-new-Passw0rd!';

const password = new PasswordService();
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const host = (slug: string) => `${slug}.${BASE_DOMAIN}`;

describe('user management + forced first-login password change (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  const roleA: Record<string, string> = {};
  const roleB: Record<string, string> = {};
  let branchA1: string;
  let branchA2: string;
  let adminAId: string;

  const server = () => app.getHttpServer();
  const login = (slug: string, email: string, pw = PASSWORD) =>
    request(server()).post('/auth/login').set('Host', host(slug)).send({ email, password: pw });
  const as = (slug: string, token: string) => ({
    get: (url: string) => request(server()).get(url).set('Host', host(slug)).set('Authorization', `Bearer ${token}`),
    post: (url: string) => request(server()).post(url).set('Host', host(slug)).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => request(server()).patch(url).set('Host', host(slug)).set('Authorization', `Bearer ${token}`),
  });
  const tokenFor = async (slug: string, email: string, pw = PASSWORD) => (await login(slug, email, pw).expect(200)).body.accessToken as string;

  async function makeUser(tenantId: string, email: string, roleId: string, extra: { branchId?: string } = {}) {
    const user = await prisma.user.create({
      data: { tenantId, email, hashedPassword: await password.hash(PASSWORD), status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    if (extra.branchId) await prisma.userBranch.create({ data: { tenantId, userId: user.id, branchId: extra.branchId } });
    return user;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app as never);
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const a = await prisma.tenant.create({ data: { name: 'UM A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    const b = await prisma.tenant.create({ data: { name: 'UM B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    tenantAId = a.id;
    tenantBId = b.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    for (const [tid, map] of [[tenantAId, roleA], [tenantBId, roleB]] as const) {
      for (const r of await prisma.role.findMany({ where: { tenantId: tid } })) map[r.name] = r.id;
    }
    branchA1 = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'A1', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchA2 = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'A2', countryCode: 'US', timezone: 'America/New_York' } })).id;

    adminAId = (await makeUser(tenantAId, 'admin@a.test', roleA[SYSTEM_ROLES.TENANT_ADMIN])).id;
    await makeUser(tenantAId, 'hr@a.test', roleA[SYSTEM_ROLES.HR_MANAGER]);
    await makeUser(tenantAId, 'emp@a.test', roleA[SYSTEM_ROLES.EMPLOYEE]);
    await makeUser(tenantBId, 'admin@b.test', roleB[SYSTEM_ROLES.TENANT_ADMIN]);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await redis.quit();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('create -> temp password -> forced first-login change', () => {
    let tempPassword: string;
    let newUserId: string;
    const email = 'newhire@a.test';

    it('HR creates a user and gets a one-time temporary password', async () => {
      const hr = await tokenFor(SLUG_A, 'hr@a.test');
      const res = await as(SLUG_A, hr)
        .post('/users')
        .send({ email, roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]], branchIds: [branchA1] })
        .expect(201);

      tempPassword = res.body.temporaryPassword;
      newUserId = res.body.id;
      expect(tempPassword).toEqual(expect.any(String));
      expect(tempPassword.length).toBeGreaterThanOrEqual(12);
      expect(res.body).toMatchObject({ email, status: 'ACTIVE', mustChangePassword: true });
      expect(res.body.roles.map((r: { name: string }) => r.name)).toEqual([SYSTEM_ROLES.EMPLOYEE]);
      expect(res.body.branches.map((b: { id: string }) => b.id)).toEqual([branchA1]);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    });

    it('stores only an argon2id hash, and the audit trail never holds the plaintext', async () => {
      const row = await prisma.user.findUniqueOrThrow({ where: { id: newUserId } });
      expect(row.hashedPassword).toMatch(/^\$argon2id\$/);
      expect(row.hashedPassword).not.toContain(tempPassword);
      expect(row.mustChangePassword).toBe(true);

      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'User', entityId: newUserId } });
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain(tempPassword);
    });

    it('the temp-password login works but flags mustChangePassword', async () => {
      const res = await login(SLUG_A, email, tempPassword).expect(200);
      expect(res.body.mustChangePassword).toBe(true);
    });

    it('is BLOCKED server-side from every normal endpoint with a distinguishable code', async () => {
      const token = await tokenFor(SLUG_A, email, tempPassword);
      for (const url of ['/tenancy/branches', '/employees/me', '/users']) {
        const res = await as(SLUG_A, token).get(url).expect(403);
        expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      // ...but may learn WHY via /auth/me.
      const me = await as(SLUG_A, token).get('/auth/me').expect(200);
      expect(me.body.mustChangePassword).toBe(true);
    });

    it('rejects a first-login "new" password that equals the temporary one, and a too-short one', async () => {
      const token = await tokenFor(SLUG_A, email, tempPassword);
      await as(SLUG_A, token).post('/auth/first-login/password').send({ newPassword: tempPassword }).expect(400);
      await as(SLUG_A, token).post('/auth/first-login/password').send({ newPassword: 'short' }).expect(400);
    });

    it('changes the password, returns a fresh session, and normal access then works', async () => {
      const token = await tokenFor(SLUG_A, email, tempPassword);
      const res = await as(SLUG_A, token).post('/auth/first-login/password').send({ newPassword: NEW_PASSWORD }).expect(200);
      expect(res.body.mustChangePassword).toBe(false);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: newUserId } });
      expect(row.mustChangePassword).toBe(false);

      await as(SLUG_A, res.body.accessToken).get('/tenancy/branches').expect(200);
      expect((await as(SLUG_A, res.body.accessToken).get('/auth/me').expect(200)).body.mustChangePassword).toBe(false);

      // The temp password is dead; the new one works; the flag stays false.
      await login(SLUG_A, email, tempPassword).expect(401);
      expect((await login(SLUG_A, email, NEW_PASSWORD).expect(200)).body.mustChangePassword).toBe(false);
    });

    it('the first-login route is dead once the flag is cleared', async () => {
      const token = await tokenFor(SLUG_A, email, NEW_PASSWORD);
      await as(SLUG_A, token).post('/auth/first-login/password').send({ newPassword: 'another-Passw0rd!' }).expect(400);
    });

    it('regenerating a temp password re-arms the flag, kills old sessions and the old password', async () => {
      const oldSession = (await login(SLUG_A, email, NEW_PASSWORD).expect(200)).body;
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const res = await as(SLUG_A, admin).post(`/users/${newUserId}/regenerate-temp-password`).expect(200);
      const second = res.body.temporaryPassword as string;
      expect(second).not.toBe(tempPassword);
      expect(res.body.mustChangePassword).toBe(true);

      await login(SLUG_A, email, NEW_PASSWORD).expect(401);
      await request(server()).post('/auth/refresh').set('Host', host(SLUG_A)).send({ refreshToken: oldSession.refreshToken }).expect(401);
      const relogin = await login(SLUG_A, email, second).expect(200);
      expect(relogin.body.mustChangePassword).toBe(true);
      await as(SLUG_A, relogin.body.accessToken).get('/tenancy/branches').expect(403);
    });
  });

  describe('list / search', () => {
    it('lists users with roles, branches, status and last login; supports search + pagination + status filter', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const all = await as(SLUG_A, admin).get('/users').expect(200);
      expect(all.body.total).toBeGreaterThanOrEqual(4);
      const adminRow = all.body.items.find((u: { email: string }) => u.email === 'admin@a.test');
      expect(adminRow).toMatchObject({ status: 'ACTIVE', manageable: false });
      expect(adminRow.lastLoginAt).toEqual(expect.any(String));
      expect(adminRow.roles[0].name).toBe(SYSTEM_ROLES.TENANT_ADMIN);

      const search = await as(SLUG_A, admin).get('/users?search=HR@A').expect(200);
      expect(search.body.items.map((u: { email: string }) => u.email)).toEqual(['hr@a.test']);

      const paged = await as(SLUG_A, admin).get('/users?pageSize=2&page=1').expect(200);
      expect(paged.body.items).toHaveLength(2);
      expect(paged.body.total).toBeGreaterThan(2);

      const disabled = await as(SLUG_A, admin).get('/users?status=DISABLED').expect(200);
      expect(disabled.body.items.every((u: { status: string }) => u.status === 'DISABLED')).toBe(true);
    });

    it('rejects a duplicate email (case-insensitively)', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      await as(SLUG_A, admin).post('/users').send({ email: 'HR@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(409);
    });
  });

  describe('edit roles / branch scope', () => {
    it('takes effect on the very next request (permission cache invalidated)', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const created = (await as(SLUG_A, admin).post('/users').send({ email: 'edit@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(201)).body;
      const first = await as(SLUG_A, admin).post(`/users/${created.id}/regenerate-temp-password`).expect(200);
      const session = (await login(SLUG_A, 'edit@a.test', first.body.temporaryPassword).expect(200)).body;
      const changed = (await as(SLUG_A, session.accessToken).post('/auth/first-login/password').send({ newPassword: NEW_PASSWORD }).expect(200)).body;

      // Warm the permission cache as an EMPLOYEE, then promote.
      expect((await as(SLUG_A, changed.accessToken).get('/auth/me').expect(200)).body.permissions).not.toContain('user.manage');
      const edited = await as(SLUG_A, admin)
        .patch(`/users/${created.id}/access`)
        .send({ roleIds: [roleA[SYSTEM_ROLES.HR_MANAGER]], branchIds: [branchA1, branchA2] })
        .expect(200);
      expect(edited.body.roles.map((r: { name: string }) => r.name)).toEqual([SYSTEM_ROLES.HR_MANAGER]);
      expect(edited.body.branches).toHaveLength(2);

      const me = await as(SLUG_A, changed.accessToken).get('/auth/me').expect(200);
      expect(me.body.permissions).toContain('user.manage');
      expect(me.body.branchIds).toHaveLength(2);

      // Clearing the scope makes the user unrestricted again.
      await as(SLUG_A, admin).patch(`/users/${created.id}/access`).send({ branchIds: [] }).expect(200);
      expect((await as(SLUG_A, changed.accessToken).get('/auth/me').expect(200)).body.branchIds).toBeNull();
    });

    it('requires at least one field and at least one role', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const target = await prisma.user.findFirstOrThrow({ where: { tenantId: tenantAId, email: 'emp@a.test' } });
      await as(SLUG_A, admin).patch(`/users/${target.id}/access`).send({}).expect(400);
      await as(SLUG_A, admin).patch(`/users/${target.id}/access`).send({ roleIds: [] }).expect(400);
    });
  });

  describe('deactivate / reactivate', () => {
    it('deactivation kills access tokens, refresh tokens and login; reactivation restores them; no hard delete', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const target = await prisma.user.findFirstOrThrow({ where: { tenantId: tenantAId, email: 'emp@a.test' } });
      const session = (await login(SLUG_A, 'emp@a.test').expect(200)).body;
      await as(SLUG_A, session.accessToken).get('/auth/me').expect(200);

      const res = await as(SLUG_A, admin).post(`/users/${target.id}/deactivate`).expect(200);
      expect(res.body.status).toBe('DISABLED');

      await as(SLUG_A, session.accessToken).get('/auth/me').expect(401);
      await request(server()).post('/auth/refresh').set('Host', host(SLUG_A)).send({ refreshToken: session.refreshToken }).expect(401);
      await login(SLUG_A, 'emp@a.test').expect(401);
      expect(await prisma.user.count({ where: { id: target.id } })).toBe(1);

      await as(SLUG_A, admin).post(`/users/${target.id}/deactivate`).expect(409);
      await as(SLUG_A, admin).post(`/users/${target.id}/reactivate`).expect(200);
      await login(SLUG_A, 'emp@a.test').expect(200);
      await as(SLUG_A, admin).post(`/users/${target.id}/reactivate`).expect(409);
    });

    it('cannot generate a temp password for a deactivated user', async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      const target = await prisma.user.findFirstOrThrow({ where: { tenantId: tenantAId, email: 'emp@a.test' } });
      await as(SLUG_A, admin).post(`/users/${target.id}/deactivate`).expect(200);
      await as(SLUG_A, admin).post(`/users/${target.id}/regenerate-temp-password`).expect(409);
      await as(SLUG_A, admin).post(`/users/${target.id}/reactivate`).expect(200);
    });
  });

  describe('RBAC + guards', () => {
    it('a user without user.manage gets 403 on every route', async () => {
      const emp = await tokenFor(SLUG_A, 'emp@a.test');
      const someId = adminAId;
      await as(SLUG_A, emp).get('/users').expect(403);
      await as(SLUG_A, emp).get('/users/assignable-roles').expect(403);
      await as(SLUG_A, emp).post('/users').send({ email: 'x@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(403);
      await as(SLUG_A, emp).patch(`/users/${someId}/access`).send({ branchIds: [] }).expect(403);
      await as(SLUG_A, emp).post(`/users/${someId}/deactivate`).expect(403);
      await as(SLUG_A, emp).post(`/users/${someId}/reactivate`).expect(403);
      await as(SLUG_A, emp).post(`/users/${someId}/regenerate-temp-password`).expect(403);
    });

    it('unauthenticated requests are rejected', async () => {
      await request(server()).get('/users').set('Host', host(SLUG_A)).expect(401);
    });

    it("cannot deactivate or edit yourself, or regenerate your own temp password", async () => {
      const admin = await tokenFor(SLUG_A, 'admin@a.test');
      await as(SLUG_A, admin).post(`/users/${adminAId}/deactivate`).expect(403);
      await as(SLUG_A, admin).patch(`/users/${adminAId}/access`).send({ branchIds: [] }).expect(403);
      await as(SLUG_A, admin).post(`/users/${adminAId}/regenerate-temp-password`).expect(403);
    });

    it('an HR manager cannot touch the admin (no privilege escalation via temp-password regeneration)', async () => {
      const hr = await tokenFor(SLUG_A, 'hr@a.test');
      await as(SLUG_A, hr).post(`/users/${adminAId}/regenerate-temp-password`).expect(403);
      await as(SLUG_A, hr).post(`/users/${adminAId}/deactivate`).expect(403);
      await as(SLUG_A, hr).patch(`/users/${adminAId}/access`).send({ branchIds: [branchA1] }).expect(403);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminAId } })).status).toBe('ACTIVE');
    });

    it('cannot grant a role carrying permissions you do not hold', async () => {
      const hr = await tokenFor(SLUG_A, 'hr@a.test');
      await as(SLUG_A, hr).post('/users').send({ email: 'esc@a.test', roleIds: [roleA[SYSTEM_ROLES.TENANT_ADMIN]] }).expect(403);
      const roles = (await as(SLUG_A, hr).get('/users/assignable-roles').expect(200)).body;
      const adminRole = roles.find((r: { name: string }) => r.name === SYSTEM_ROLES.TENANT_ADMIN);
      const empRole = roles.find((r: { name: string }) => r.name === SYSTEM_ROLES.EMPLOYEE);
      expect(adminRole.assignable).toBe(false);
      expect(empRole.assignable).toBe(true);
    });

    it('a branch-restricted manager can only assign scopes within their own', async () => {
      const limited = await makeUser(tenantAId, 'limited@a.test', roleA[SYSTEM_ROLES.HR_MANAGER], { branchId: branchA1 });
      const token = await tokenFor(SLUG_A, 'limited@a.test');
      await as(SLUG_A, token).post('/users').send({ email: 'l1@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(403); // unrestricted grant
      await as(SLUG_A, token).post('/users').send({ email: 'l2@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]], branchIds: [branchA2] }).expect(403);
      await as(SLUG_A, token).post('/users').send({ email: 'l3@a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]], branchIds: [branchA1] }).expect(201);
      expect(limited.id).toBeDefined();
    });

    it('the last active admin cannot be deactivated or demoted, even by a non-admin superuser', async () => {
      // A custom role holding EVERY permission passes the escalation guard
      // without being TENANT_ADMIN — the only way to reach this guard.
      const superRole = await prisma.role.create({ data: { tenantId: tenantAId, name: 'SUPER_CUSTOM', isSystem: false } });
      const perms = await prisma.permission.findMany({ where: { tenantId: tenantAId } });
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ tenantId: tenantAId, roleId: superRole.id, permissionId: p.id })) });
      await makeUser(tenantAId, 'super@a.test', superRole.id);
      const superToken = await tokenFor(SLUG_A, 'super@a.test');

      await as(SLUG_A, superToken).post(`/users/${adminAId}/deactivate`).expect(409);
      await as(SLUG_A, superToken).patch(`/users/${adminAId}/access`).send({ roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(409);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminAId } })).status).toBe('ACTIVE');

      // With a SECOND active admin, the first may be deactivated.
      const second = await makeUser(tenantAId, 'admin2@a.test', roleA[SYSTEM_ROLES.TENANT_ADMIN]);
      await as(SLUG_A, superToken).post(`/users/${adminAId}/deactivate`).expect(200);
      await as(SLUG_A, superToken).post(`/users/${second.id}/deactivate`).expect(409); // now the last one
      await as(SLUG_A, superToken).post(`/users/${adminAId}/reactivate`).expect(200);
    });
  });

  describe('cross-tenant isolation', () => {
    it("tenant B's admin never sees, nor can touch, tenant A's users or roles", async () => {
      const adminB = await tokenFor(SLUG_B, 'admin@b.test');
      const list = await as(SLUG_B, adminB).get('/users').expect(200);
      expect(list.body.items.map((u: { email: string }) => u.email)).toEqual(['admin@b.test']);
      expect((await as(SLUG_B, adminB).get('/users?search=a.test').expect(200)).body.total).toBe(0);

      await as(SLUG_B, adminB).patch(`/users/${adminAId}/access`).send({ branchIds: [] }).expect(404);
      await as(SLUG_B, adminB).post(`/users/${adminAId}/deactivate`).expect(404);
      await as(SLUG_B, adminB).post(`/users/${adminAId}/regenerate-temp-password`).expect(404);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminAId } })).status).toBe('ACTIVE');

      // Foreign role / branch ids are indistinguishable from nonexistent ones.
      await as(SLUG_B, adminB).post('/users').send({ email: 'x@b.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]] }).expect(400);
      await as(SLUG_B, adminB)
        .post('/users')
        .send({ email: 'y@b.test', roleIds: [roleB[SYSTEM_ROLES.EMPLOYEE]], branchIds: [branchA1] })
        .expect(400);

      // The same email may exist in both tenants.
      await as(SLUG_B, adminB).post('/users').send({ email: 'hr@a.test', roleIds: [roleB[SYSTEM_ROLES.EMPLOYEE]] }).expect(201);
    });

    it("A's session token is useless against B's host", async () => {
      const adminA = await tokenFor(SLUG_A, 'admin@a.test');
      await as(SLUG_B, adminA).get('/users').expect(401);
    });
  });
});
