/**
 * Proves step 8.1 Part 1 (configurable working-hours policy) end to end over
 * real HTTP + Postgres: the 3-scope precedence (member > team > company >
 * Country Pack), CRUD + validation guards, RBAC, branch scoping and
 * cross-tenant isolation. See docs/conventions/working-hours.md.
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
const SLUG_A = 'wh-test-a';
const SLUG_B = 'wh-test-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;

const POLICY = { startTime: '09:00', workHours: 8, breakHours: 1, graceMinutes: 15, halfDayThresholdHours: 4.5 };

describe('working-hours policy (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchUs: string;
  let branchQa: string;
  let parentDept: string;
  let childDept: string;
  let otherDept: string;
  let empMember: { id: string };
  let empTeam: { id: string };
  let empChild: { id: string };
  let empPlain: { id: string };
  let empQa: { id: string };
  let empBOther: { id: string };
  let tokenHr: string;
  let tokenEmp: string;
  let tokenBranchRestrictedHr: string;
  let tokenAdminB: string;
  let n = 0;

  const call = (slug: string, token: string) => ({
    get: (u: string) => request(app.getHttpServer()).get(u).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
    put: (u: string) => request(app.getHttpServer()).put(u).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
    del: (u: string) => request(app.getHttpServer()).delete(u).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
  });
  const hr = () => call(SLUG_A, tokenHr);

  async function makeEmployee(tenantId: string, branchId: string, departmentId: string | null, userId: string | null = null) {
    n += 1;
    return prisma.employee.create({
      data: { tenantId, branchId, departmentId, userId, employeeCode: `WH-${n}-${Date.now() % 100000}`, firstName: `Emp${n}`, lastName: 'Test', employmentType: 'FULL_TIME', joinDate: new Date('2020-01-01'), status: 'ACTIVE' },
    });
  }
  async function makeUser(tenantId: string, email: string, roleName: string, branchId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: roleName } } });
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    if (branchId) await prisma.userBranch.create({ data: { tenantId, userId: user.id, branchId } });
    return { user, token: jwt.sign({ sub: user.id, tenantId }) };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);
    tenantAId = (await prisma.tenant.create({ data: { name: 'WH A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } })).id;
    tenantBId = (await prisma.tenant.create({ data: { name: 'WH B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } })).id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    branchUs = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'US HQ', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchQa = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Doha', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;
    const branchB = (await prisma.branch.create({ data: { tenantId: tenantBId, name: 'B HQ', countryCode: 'US', timezone: 'America/New_York' } })).id;
    parentDept = (await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Engineering' } })).id;
    childDept = (await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Platform', parentDepartmentId: parentDept } })).id;
    otherDept = (await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Sales' } })).id;

    empMember = await makeEmployee(tenantAId, branchUs, parentDept);
    empTeam = await makeEmployee(tenantAId, branchUs, parentDept);
    empChild = await makeEmployee(tenantAId, branchUs, childDept);
    empPlain = await makeEmployee(tenantAId, branchUs, otherDept);
    empQa = await makeEmployee(tenantAId, branchQa, null);
    empBOther = await makeEmployee(tenantBId, branchB, null);

    tokenHr = (await makeUser(tenantAId, 'hr@wh-a.test', SYSTEM_ROLES.HR_MANAGER)).token;
    tokenBranchRestrictedHr = (await makeUser(tenantAId, 'hr-qa@wh-a.test', SYSTEM_ROLES.HR_MANAGER, branchQa)).token;
    const empUser = await makeUser(tenantAId, 'emp@wh-a.test', SYSTEM_ROLES.EMPLOYEE);
    tokenEmp = empUser.token;
    await prisma.employee.update({ where: { id: empPlain.id }, data: { userId: empUser.user.id } });
    tokenAdminB = (await makeUser(tenantBId, 'admin@wh-b.test', SYSTEM_ROLES.TENANT_ADMIN)).token;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  const effective = async (employeeId: string) => (await hr().get(`/working-hours/effective?employeeId=${employeeId}`).expect(200)).body;

  describe('resolution precedence — each layer proven', () => {
    it('4. with NO policy rows the Country Pack decides — and it differs by country (same code)', async () => {
      const us = await effective(empPlain.id);
      expect(us.source).toBe('COUNTRY_PACK');
      expect(us.policy).toMatchObject({ startTime: '09:00', workHours: 8, breakHours: 1, requiredHours: 9, graceMinutes: 15, halfDayThresholdHours: 4.5, halfDayThresholdDerived: true });
      expect(us.timezone).toBe('America/New_York');
      const qa = await effective(empQa.id);
      expect(qa.source).toBe('COUNTRY_PACK');
      expect(qa.policy.workHours).toBe(9.6); // QA pack: 48h / 5 working days
      expect(qa.timezone).toBe('Asia/Qatar'); // the BRANCH timezone, never stored on a policy
    });

    it('3. the company default beats the Country Pack', async () => {
      await hr().put('/working-hours/company').send({ ...POLICY, startTime: '08:30', workHours: 7.5 }).expect(200);
      const e = await effective(empPlain.id);
      expect(e).toMatchObject({ source: 'COMPANY', policyId: expect.any(String) });
      expect(e.policy).toMatchObject({ startTime: '08:30', workHours: 7.5, requiredHours: 8.5 });
      // ...for the Qatar-branch employee too (company default is tenant-wide)
      expect((await effective(empQa.id)).source).toBe('COMPANY');
    });

    it('2. a team (department) policy beats the company default, and a sub-team inherits its nearest ancestor', async () => {
      await hr().put(`/working-hours/teams/${parentDept}`).send({ ...POLICY, startTime: '10:00', graceMinutes: 5, halfDayThresholdHours: null }).expect(200);
      const team = await effective(empTeam.id);
      expect(team).toMatchObject({ source: 'TEAM', sourceDepartmentId: parentDept });
      expect(team.policy).toMatchObject({ startTime: '10:00', graceMinutes: 5, halfDayThresholdDerived: true, halfDayThresholdHours: 4.5 });
      const child = await effective(empChild.id); // Platform has none of its own -> inherits Engineering
      expect(child).toMatchObject({ source: 'TEAM', sourceDepartmentId: parentDept });
      // a closer policy on the child wins over the ancestor
      await hr().put(`/working-hours/teams/${childDept}`).send({ ...POLICY, startTime: '11:00' }).expect(200);
      expect(await effective(empChild.id)).toMatchObject({ source: 'TEAM', sourceDepartmentId: childDept });
      expect((await effective(empChild.id)).policy.startTime).toBe('11:00');
      // other departments are untouched
      expect((await effective(empPlain.id)).source).toBe('COMPANY');
    });

    it('1. a member override beats team and company', async () => {
      await hr().put(`/working-hours/members/${empMember.id}`).send({ ...POLICY, startTime: '07:00', workHours: 6, breakHours: 0.5, halfDayThresholdHours: 3 }).expect(200);
      const m = await effective(empMember.id);
      expect(m).toMatchObject({ source: 'MEMBER' });
      expect(m.policy).toMatchObject({ startTime: '07:00', requiredHours: 6.5, halfDayThresholdHours: 3, halfDayThresholdDerived: false });
      // a teammate without an override still resolves to the team policy
      expect((await effective(empTeam.id)).source).toBe('TEAM');
    });

    it('removing an override falls back one layer at a time', async () => {
      await hr().del(`/working-hours/members/${empMember.id}`).expect(200);
      expect((await effective(empMember.id)).source).toBe('TEAM');
      await hr().del(`/working-hours/teams/${parentDept}`).expect(200);
      expect((await effective(empTeam.id)).source).toBe('COMPANY');
      await hr().del(`/working-hours/teams/${childDept}`).expect(200);
      await hr().del(`/working-hours/members/${empMember.id}`).expect(404);
    });
  });

  describe('CRUD + validation guards', () => {
    it('lists every policy with its scope and target', async () => {
      await hr().put(`/working-hours/teams/${otherDept}`).send(POLICY).expect(200);
      await hr().put(`/working-hours/members/${empMember.id}`).send(POLICY).expect(200);
      const list = (await hr().get('/working-hours/policies').expect(200)).body;
      const byScope = (s: string) => list.filter((p: { scope: string }) => p.scope === s);
      expect(byScope('COMPANY')).toHaveLength(1);
      expect(byScope('TEAM')[0].target).toMatchObject({ id: otherDept, label: 'Sales' });
      expect(byScope('MEMBER')[0].target.id).toBe(empMember.id);
      expect(byScope('TEAM')[0]).toMatchObject({ workHours: 8, breakHours: 1, requiredHours: 9, graceMinutes: 15 });
      // upsert is idempotent per target (no duplicates)
      await hr().put(`/working-hours/teams/${otherDept}`).send({ ...POLICY, graceMinutes: 20 }).expect(200);
      expect(byScope('TEAM')).toHaveLength(1);
      expect((await hr().get('/working-hours/policies').expect(200)).body.filter((p: { scope: string }) => p.scope === 'TEAM')).toHaveLength(1);
    });

    it.each([
      ['a malformed time', { ...POLICY, startTime: '9am' }],
      ['an out-of-range time', { ...POLICY, startTime: '25:00' }],
      ['zero work hours', { ...POLICY, workHours: 0 }],
      ['negative work hours', { ...POLICY, workHours: -1 }],
      ['negative break hours', { ...POLICY, breakHours: -0.5 }],
      ['negative grace', { ...POLICY, graceMinutes: -1 }],
      ['a half-day threshold >= required hours', { ...POLICY, halfDayThresholdHours: 9 }],
      ['a zero half-day threshold', { ...POLICY, halfDayThresholdHours: 0 }],
      ['work + break over 24h', { ...POLICY, workHours: 23, breakHours: 2, halfDayThresholdHours: null }],
      ['an unknown field', { ...POLICY, shiftName: 'x' }],
    ])('rejects %s with 400', async (_name, body) => {
      await hr().put('/working-hours/company').send(body).expect(400);
    });

    it('404s for an unknown department / employee', async () => {
      await hr().put('/working-hours/teams/33333333-3333-4333-8333-333333333333').send(POLICY).expect(404);
      await hr().put('/working-hours/members/33333333-3333-4333-8333-333333333333').send(POLICY).expect(404);
    });

    it('audits every change', async () => {
      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'WorkingHoursPolicy' } });
      const actions = new Set(audits.map((a) => a.action));
      expect(actions).toEqual(expect.objectContaining({}));
      for (const a of ['SET_COMPANY', 'SET_TEAM', 'SET_MEMBER', 'REMOVE_TEAM', 'REMOVE_MEMBER']) expect(actions.has(a)).toBe(true);
    });
  });

  describe('RBAC + scope', () => {
    it('a plain member gets 403 on every admin route', async () => {
      const e = call(SLUG_A, tokenEmp);
      await e.get('/working-hours/policies').expect(403);
      await e.get('/working-hours/targets').expect(403);
      await e.put('/working-hours/company').send(POLICY).expect(403);
      await e.put(`/working-hours/teams/${otherDept}`).send(POLICY).expect(403);
      await e.del(`/working-hours/members/${empMember.id}`).expect(403);
    });

    it('a member can read their OWN effective policy, but not someone else\'s', async () => {
      const e = call(SLUG_A, tokenEmp);
      expect((await e.get('/working-hours/effective').expect(200)).body.employeeId).toBe(empPlain.id);
      await e.get(`/working-hours/effective?employeeId=${empMember.id}`).expect(403);
    });

    it('a branch-restricted HR cannot touch the company default or targets outside their branch', async () => {
      const r = call(SLUG_A, tokenBranchRestrictedHr);
      await r.put('/working-hours/company').send(POLICY).expect(403);
      await r.put(`/working-hours/members/${empMember.id}`).send(POLICY).expect(403); // US employee
      await r.put(`/working-hours/members/${empQa.id}`).send(POLICY).expect(200); // Doha employee
      const list = (await r.get('/working-hours/policies').expect(200)).body;
      expect(list.some((p: { scope: string }) => p.scope === 'COMPANY')).toBe(true);
      expect(list.some((p: { target?: { id: string } }) => p.target?.id === empMember.id)).toBe(false);
      await r.get(`/working-hours/effective?employeeId=${empMember.id}`).expect(403);
    });

    it('serves dropdown targets (departments + employees)', async () => {
      const t = (await hr().get('/working-hours/targets').expect(200)).body;
      expect(t.departments.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['Engineering', 'Platform', 'Sales']));
      expect(t.employees.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('cross-tenant isolation', () => {
    it("tenant B can't see, resolve, or change tenant A's policies", async () => {
      const b = call(SLUG_B, tokenAdminB);
      expect((await b.get('/working-hours/policies').expect(200)).body).toEqual([]);
      await b.get(`/working-hours/effective?employeeId=${empMember.id}`).expect(404);
      await b.put(`/working-hours/members/${empMember.id}`).send(POLICY).expect(404);
      await b.put(`/working-hours/teams/${otherDept}`).send(POLICY).expect(404);
      await b.del(`/working-hours/teams/${otherDept}`).expect(404);
      // B's own company default is independent of A's
      await b.put('/working-hours/company').send({ ...POLICY, startTime: '06:00' }).expect(200);
      expect((await hr().get('/working-hours/policies').expect(200)).body.find((p: { scope: string }) => p.scope === 'COMPANY').startTime).not.toBe('06:00');
      expect((await b.get(`/working-hours/effective?employeeId=${empBOther.id}`).expect(200)).body.source).toBe('COMPANY');
    });
  });
});
