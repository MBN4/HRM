/**
 * Proves the Leave module (step 1.2, Phase 1) end to end over real HTTP —
 * see docs/conventions/leave.md: country-driven entitlements + the
 * two-layer override (same code, US vs. QA), weekend/holiday-aware business
 * day counting, a real submission running through the real 0.7 workflow
 * engine to the real 1.1 manager (balance deducted on approve, untouched on
 * reject), the scheduled accrual job (pro-rating a mid-period joiner,
 * idempotent on re-run), team conflict detection, RBAC deny-by-default, and
 * cross-tenant isolation (RLS).
 *
 * A JWT is minted directly, same rationale every other e2e suite in this
 * codebase documents for doing the same thing.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis minio
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
import { LEAVE_REQUEST_ENTITY_TYPE } from '../src/leave/leave.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'leave-test-tenant-a';
const TENANT_B_SLUG = 'leave-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 10000, intervalMs = 150): Promise<T> {
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

describe('leave (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAUsId: string;
  let branchAQaId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenNoLeavePermA: string;
  let tokenAdminB: string;

  let empCounter = 0;
  async function makeEmployee(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    empCounter += 1;
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `LV-${empCounter}`,
        firstName: 'Test',
        lastName: `Employee${empCounter}`,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
        ...overrides,
      },
    });
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Leave Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Leave Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchAUs = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A US HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchAUsId = branchAUs.id;
    const branchAQa = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchAQaId = branchAQa.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const hrRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } },
    });
    const adminRoleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const noPermRoleA = await prisma.role.create({ data: { tenantId: tenantAId, name: 'NO_LEAVE_PERMS', isSystem: false } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@leave-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@leave-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });

    const noPermA = await makeUserWithRole(tenantAId, noPermRoleA.id, 'no-perms@leave-a.test');
    tokenNoLeavePermA = jwt.sign({ sub: noPermA.id, tenantId: tenantAId });

    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@leave-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // The default leave-approval template — see docs/conventions/leave.md:
    // a leave request just starts a WorkflowInstance under this template,
    // no bespoke approval logic in this module at all.
    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Leave Approval', entityType: LEAVE_REQUEST_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: template.id, name: 'Manager approval', order: 1, approverRule: { type: 'MANAGER' } },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      .post(path)
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  describe('entitlements — country-driven, two-layer override', () => {
    it('the same code resolves different default entitlements for a US vs. a QA employee', async () => {
      const usEmployee = await makeEmployee(tenantAId, branchAUsId);
      const usRes = await post(`/leave/balances/${usEmployee.id}/adjust`, tokenHrA, {
        leaveType: 'ANNUAL',
        deltaDays: 0,
      }).expect(201);
      expect(usRes.body.entitledDays).toBe(10);

      const qaEmployee = await makeEmployee(tenantAId, branchAQaId);
      const qaRes = await post(`/leave/balances/${qaEmployee.id}/adjust`, tokenHrA, {
        leaveType: 'ANNUAL',
        deltaDays: 0,
      }).expect(201);
      expect(qaRes.body.entitledDays).toBe(21);
    });
  });

  describe('weekend + holiday exclusion — same code, different pack, timezone-safe', () => {
    it('a US request spanning a weekend and New Year\'s Day counts only true business days', async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId);
      // The request below starts in 2025 (its balance is keyed by the
      // request's own start-year — see LeaveService.submit), so the
      // top-up must target periodYear 2025, not the adjust endpoint's
      // "current calendar year" default.
      await post(`/leave/balances/${employee.id}/adjust`, tokenHrA, {
        leaveType: 'ANNUAL',
        deltaDays: 10,
        periodYear: 2025,
      }).expect(201);

      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });
      const user = await makeUserWithRole(tenantAId, employeeRoleA.id, `us-daycount-${employee.id}@leave-a.test`);
      await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
      const token = jwt.sign({ sub: user.id, tenantId: tenantAId });

      // Mon 12/29, Tue 12/30, Wed 12/31, Thu 1/1 (holiday), Fri 1/2, Sat 1/3 (weekend), Sun 1/4 (weekend)
      // -> business days: Mon, Tue, Wed, Fri = 4.
      const res = await post('/leave/requests', token, {
        leaveType: 'ANNUAL',
        startDate: '2025-12-29',
        endDate: '2026-01-04',
      }).expect(201);
      expect(res.body.days).toBe(4);
    });

    it('a QA request spanning a Fri/Sat weekend and National Sports Day counts only true business days', async () => {
      const employee = await makeEmployee(tenantAId, branchAQaId);
      await post(`/leave/balances/${employee.id}/adjust`, tokenHrA, { leaveType: 'ANNUAL', deltaDays: 21 }).expect(201);

      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });
      const user = await makeUserWithRole(tenantAId, employeeRoleA.id, `qa-daycount-${employee.id}@leave-a.test`);
      await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
      const token = jwt.sign({ sub: user.id, tenantId: tenantAId });

      // Mon 2/9, Tue 2/10, Wed 2/11 (holiday), Thu 2/12, Fri 2/13 (weekend), Sat 2/14 (weekend)
      // -> business days: Mon, Tue, Thu = 3.
      const res = await post('/leave/requests', token, {
        leaveType: 'ANNUAL',
        startDate: '2026-02-09',
        endDate: '2026-02-14',
      }).expect(201);
      expect(res.body.days).toBe(3);
    });
  });

  describe('a leave request runs through the real 0.7 workflow to the real 1.1 manager', () => {
    let managerToken: string;
    let subordinateToken: string;
    let subordinateEmployeeId: string;
    let managerUserId: string;

    beforeAll(async () => {
      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });

      const managerUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'leave-manager@leave-a.test');
      managerUserId = managerUser.id;
      managerToken = jwt.sign({ sub: managerUser.id, tenantId: tenantAId });
      const managerEmployee = await makeEmployee(tenantAId, branchAUsId, { userId: managerUser.id });

      const subordinateUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'leave-subordinate@leave-a.test');
      subordinateToken = jwt.sign({ sub: subordinateUser.id, tenantId: tenantAId });
      const subordinateEmployee = await makeEmployee(tenantAId, branchAUsId, {
        userId: subordinateUser.id,
        managerId: managerEmployee.id,
      });
      subordinateEmployeeId = subordinateEmployee.id;

      await post(`/leave/balances/${subordinateEmployeeId}/adjust`, tokenHrA, { leaveType: 'ANNUAL', deltaDays: 10 }).expect(201);
    });

    it('deducts the balance when the real manager approves', async () => {
      const submitRes = await post('/leave/requests', subordinateToken, {
        leaveType: 'ANNUAL',
        startDate: '2026-03-02',
        endDate: '2026-03-03',
      }).expect(201);
      expect(submitRes.body.status).toBe('PENDING');
      expect(submitRes.body.days).toBe(2);
      const instanceId = submitRes.body.workflowInstanceId;

      const detailRes = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = detailRes.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(activeStep.eligibleApproverIds).toContain(managerUserId);

      await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(
        201,
      );

      // The balance deduction is applied by LeaveWorkflowEventsListener,
      // fire-and-forget off the workflow engine's `workflow.approved` event
      // (the same async-dispatch shape 0.8/0.9 already document) — poll
      // rather than assert immediately after the approve response returns.
      const annual = await waitFor(async () => {
        const res = await get(`/leave/balances?employeeId=${subordinateEmployeeId}&year=2026`, tokenHrA).expect(200);
        const row = res.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL');
        return row && row.usedDays > 0 ? row : null;
      });
      expect(annual.usedDays).toBe(2);
      expect(annual.availableDays).toBe(8);

      const requestRes = await waitFor(async () => {
        const res = await get(`/leave/requests/${submitRes.body.id}`, subordinateToken).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });
      expect(requestRes.status).toBe('APPROVED');
    });

    it('leaves the balance untouched when the manager rejects', async () => {
      const before = await get(`/leave/balances?employeeId=${subordinateEmployeeId}&year=2026`, tokenHrA).expect(200);
      const usedBefore = before.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL').usedDays;

      const submitRes = await post('/leave/requests', subordinateToken, {
        leaveType: 'ANNUAL',
        startDate: '2026-03-09',
        endDate: '2026-03-09',
      }).expect(201);
      const instanceId = submitRes.body.workflowInstanceId;

      const detailRes = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = detailRes.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'REJECT' }).expect(
        201,
      );

      const requestRes = await waitFor(async () => {
        const res = await get(`/leave/requests/${submitRes.body.id}`, subordinateToken).expect(200);
        return res.body.status === 'REJECTED' ? res.body : null;
      });
      expect(requestRes.status).toBe('REJECTED');

      const after = await get(`/leave/balances?employeeId=${subordinateEmployeeId}&year=2026`, tokenHrA).expect(200);
      const usedAfter = after.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL').usedDays;
      expect(usedAfter).toBe(usedBefore);
    });
  });

  describe('scheduled accrual — pro-rated, idempotent', () => {
    it('accrues a pro-rated amount for a mid-month joiner and never double-accrues on re-run', async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId, { joinDate: new Date('2026-04-16') });

      await post('/leave/accrual/run', tokenHrA, { periodYear: 2026, periodMonth: 4 }).expect(201);

      // April has 30 days; joined on the 16th -> 15 remaining days of 30.
      const expectedAccrual = (10 / 12) * (15 / 30);

      const balances = await waitFor(async () => {
        const res = await get(`/leave/balances?employeeId=${employee.id}&year=2026`, tokenHrA).expect(200);
        const annual = res.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL');
        return annual && annual.accruedDays > 0 ? annual : null;
      }, 15000);
      expect(balances.accruedDays).toBeCloseTo(expectedAccrual, 5);

      // Re-run the exact same period — must not double-accrue.
      await post('/leave/accrual/run', tokenHrA, { periodYear: 2026, periodMonth: 4 }).expect(201);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const afterRerun = await get(`/leave/balances?employeeId=${employee.id}&year=2026`, tokenHrA).expect(200);
      const annualAfter = afterRerun.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL');
      expect(annualAfter.accruedDays).toBeCloseTo(expectedAccrual, 5);

      const runs = await prisma.leaveAccrualRun.findMany({
        where: { employeeId: employee.id, leaveType: 'ANNUAL', periodYear: 2026, periodMonth: 4 },
      });
      expect(runs).toHaveLength(1);
    }, 20000);
  });

  describe('conflict detection — flags overlapping team leave', () => {
    it('flags two different employees\' overlapping approved/pending requests in the same branch', async () => {
      const employeeOne = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenantAId, branchId: branchAUsId } });
      const employeeTwo = await makeEmployee(tenantAId, branchAUsId);

      await prisma.leaveRequest.create({
        data: {
          tenantId: tenantAId,
          employeeId: employeeOne.id,
          leaveType: 'ANNUAL',
          startDate: new Date('2026-06-01'),
          endDate: new Date('2026-06-05'),
          days: 5,
          status: 'APPROVED',
        },
      });
      await prisma.leaveRequest.create({
        data: {
          tenantId: tenantAId,
          employeeId: employeeTwo.id,
          leaveType: 'ANNUAL',
          startDate: new Date('2026-06-04'),
          endDate: new Date('2026-06-08'),
          days: 5,
          status: 'PENDING',
        },
      });

      const res = await get(
        `/leave/conflicts?branchId=${branchAUsId}&from=2026-06-01&to=2026-06-08`,
        tokenHrA,
      ).expect(200);
      const employeeIds = res.body.map((r: { employeeId: string }) => r.employeeId);
      expect(employeeIds).toEqual(expect.arrayContaining([employeeOne.id, employeeTwo.id]));
    });
  });

  describe('team calendar', () => {
    it('lists approved leave within the requested window for a branch', async () => {
      const res = await get(`/leave/calendar?branchId=${branchAUsId}&from=2026-06-01&to=2026-06-08`, tokenHrA).expect(200);
      expect(res.body.every((entry: { leaveType: string }) => entry.leaveType === 'ANNUAL')).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('RBAC deny-by-default', () => {
    it('rejects a submit without leave.write', async () => {
      await post('/leave/requests', tokenNoLeavePermA, {
        leaveType: 'ANNUAL',
        startDate: '2026-05-01',
        endDate: '2026-05-01',
      }).expect(403);
    });

    it('rejects a balance adjustment without leave.approve', async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId);
      await post(`/leave/balances/${employee.id}/adjust`, tokenNoLeavePermA, { leaveType: 'ANNUAL', deltaDays: 1 }).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot read tenant A's leave request by id, and lists none of tenant A's requests", async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId);
      const request_ = await prisma.leaveRequest.create({
        data: {
          tenantId: tenantAId,
          employeeId: employee.id,
          leaveType: 'ANNUAL',
          startDate: new Date('2026-07-01'),
          endDate: new Date('2026-07-01'),
          days: 1,
          status: 'PENDING',
        },
      });

      await get(`/leave/requests/${request_.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);

      const listRes = await get('/leave/requests', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listRes.body.some((r: { id: string }) => r.id === request_.id)).toBe(false);
    });
  });

  describe('tenant override — raises entitlement above the pack floor, rejected below it', () => {
    it('a tenant override above the legal floor is reflected in the resolved entitlement', async () => {
      await request(app.getHttpServer())
        .put('/country-packs/overrides/US')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ leaveDefaults: { annualDays: 25 } })
        .expect(200);

      const employee = await makeEmployee(tenantAId, branchAUsId);
      const res = await post(`/leave/balances/${employee.id}/adjust`, tokenHrA, { leaveType: 'ANNUAL', deltaDays: 0 }).expect(
        201,
      );
      expect(res.body.entitledDays).toBe(25);
    });

    it('rejects an override that would drop annual leave below the pack legal floor (10 days)', async () => {
      const res = await request(app.getHttpServer())
        .put('/country-packs/overrides/US')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ leaveDefaults: { annualDays: 5 } })
        .expect(400);
      expect(res.body.message).toMatch(/legal floor/);
    });
  });
});
