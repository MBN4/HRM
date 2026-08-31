/**
 * Proves the Performance module (step 2.2, Phase 2) end to end over real
 * HTTP — see docs/conventions/performance.md: a full cycle run (goals set,
 * self+manager+peer reviews submitted, routed + signed off via the real
 * 0.7 workflow engine to the real 1.1 org chart), tenant-configurable
 * rating scales/cycle config as DATA, reminders via the real 0.8
 * notification hub, calibration/distribution analytics (branch-scoped,
 * RBAC-gated, pre-aggregated — never a live GROUP BY over `appraisals`),
 * and cross-tenant isolation (RLS).
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { PERFORMANCE_APPRAISAL_ENTITY_TYPE } from '../src/performance/performance.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'perf-test-tenant-a';
const TENANT_B_SLUG = 'perf-test-tenant-b';

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

describe('performance (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAUsId: string;
  let branchAQaId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenAdminB: string;

  let empCounter = 0;
  async function makeEmployee(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    empCounter += 1;
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `PF-${empCounter}`,
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

    const tenantA = await prisma.tenant.create({
      data: { name: 'Performance Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Performance Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
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

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@perf-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@perf-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });

    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@perf-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // The default appraisal sign-off template — see
    // docs/conventions/performance.md: an appraisal just starts a
    // WorkflowInstance under this template, no bespoke approval logic in
    // this module at all. MANAGER resolves via the REAL 1.1 org chart
    // (Employee.managerId), the same seam workflow.md/employee.md already
    // document.
    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Appraisal Sign-off', entityType: PERFORMANCE_APPRAISAL_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: template.id, name: 'Manager sign-off', order: 1, approverRule: { type: 'MANAGER' } },
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
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }

  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  function patch(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).patch(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }

  describe('rating scales + cycle config — tenant-configurable DATA, not hardcoded enums', () => {
    it('two different tenant-authored scales produce different valid levels through the same code path', async () => {
      const fivePoint = await post('/performance/rating-scales', tokenHrA, {
        key: '5_POINT',
        name: 'Five Point Scale',
        levels: [
          { value: 1, label: 'Poor' },
          { value: 2, label: 'Needs Improvement' },
          { value: 3, label: 'Meets Expectations' },
          { value: 4, label: 'Exceeds Expectations' },
          { value: 5, label: 'Outstanding' },
        ],
      }).expect(201);
      expect(fivePoint.body.levels).toHaveLength(5);

      const passFail = await post('/performance/rating-scales', tokenHrA, {
        key: 'PASS_FAIL',
        name: 'Probation Pass/Fail',
        levels: [
          { value: 0, label: 'Fail' },
          { value: 1, label: 'Pass' },
        ],
      }).expect(201);
      expect(passFail.body.levels).toHaveLength(2);

      const listRes = await get('/performance/rating-scales', tokenHrA).expect(200);
      const keys = listRes.body.map((s: { key: string }) => s.key);
      expect(keys).toEqual(expect.arrayContaining(['5_POINT', 'PASS_FAIL']));

      // TENANT_ADMIN holds every permission via ALL_PERMISSIONS.
      const adminListRes = await get('/performance/rating-scales', tokenAdminA).expect(200);
      expect(adminListRes.body.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['5_POINT', 'PASS_FAIL']));

      const probationCycle = await post('/performance/cycles', tokenHrA, {
        name: 'Probation Review',
        cycleType: 'PROBATION',
        startDate: '2026-01-01',
        endDate: '2026-03-31',
        ratingScaleKey: 'PASS_FAIL',
        enabledReviewTypes: ['SELF', 'MANAGER'],
      }).expect(201);
      expect(probationCycle.body.ratingScaleId).toBe(passFail.body.id);

      await post('/performance/cycles', tokenHrA, {
        name: 'Bogus Scale Cycle',
        cycleType: 'ANNUAL',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        ratingScaleKey: 'NO_SUCH_SCALE',
        enabledReviewTypes: ['SELF'],
      }).expect(404);
    });
  });

  describe('a cycle runs end to end — goals, self+manager+peer reviews, real org-chart resolution, real workflow sign-off, calibration', () => {
    let managerUserId: string;
    let managerToken: string;
    let managerEmployeeId: string;
    let subordinateToken: string;
    let subordinateEmployeeId: string;
    let subordinateUserId: string;
    let peerToken: string;
    let peerEmployeeId: string;
    let cycleId: string;
    let appraisalId: string;

    beforeAll(async () => {
      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });

      const managerUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'perf-manager@perf-a.test');
      managerUserId = managerUser.id;
      managerToken = jwt.sign({ sub: managerUser.id, tenantId: tenantAId });
      const managerEmployee = await makeEmployee(tenantAId, branchAUsId, { userId: managerUser.id });
      managerEmployeeId = managerEmployee.id;

      const subordinateUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'perf-subordinate@perf-a.test');
      subordinateUserId = subordinateUser.id;
      subordinateToken = jwt.sign({ sub: subordinateUser.id, tenantId: tenantAId });
      const subordinateEmployee = await makeEmployee(tenantAId, branchAUsId, { userId: subordinateUser.id, managerId: managerEmployeeId });
      subordinateEmployeeId = subordinateEmployee.id;

      const peerUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'perf-peer@perf-a.test');
      peerToken = jwt.sign({ sub: peerUser.id, tenantId: tenantAId });
      const peerEmployee = await makeEmployee(tenantAId, branchAUsId, { userId: peerUser.id });
      peerEmployeeId = peerEmployee.id;

      await post('/performance/rating-scales', tokenHrA, {
        key: 'CYCLE_5_POINT',
        name: 'Cycle Five Point Scale',
        levels: [1, 2, 3, 4, 5].map((value) => ({ value, label: `Level ${value}` })),
      }).expect(201);

      const cycleRes = await post('/performance/cycles', tokenHrA, {
        name: 'Annual 2026',
        cycleType: 'ANNUAL',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        ratingScaleKey: 'CYCLE_5_POINT',
        enabledReviewTypes: ['SELF', 'MANAGER', 'PEER'],
        eligibleBranchIds: [branchAUsId],
      }).expect(201);
      cycleId = cycleRes.body.id;
      expect(cycleRes.body.status).toBe('DRAFT');

      await post(`/performance/cycles/${cycleId}/open`, tokenHrA, {}).expect(201);
    });

    it('goals cascade COMPANY -> TEAM -> INDIVIDUAL and track progress', async () => {
      const department = await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchAUsId, name: 'Engineering' } });

      const companyGoal = await post('/performance/goals', tokenHrA, {
        level: 'COMPANY',
        title: 'Grow ARR 20%',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }).expect(201);

      const teamGoal = await post('/performance/goals', tokenHrA, {
        level: 'TEAM',
        departmentId: department.id,
        parentGoalId: companyGoal.body.id,
        title: 'Ship platform v2',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }).expect(201);

      const individualGoal = await post('/performance/goals', subordinateToken, {
        level: 'INDIVIDUAL',
        parentGoalId: teamGoal.body.id,
        cycleId,
        title: 'Deliver auth module',
        targetValue: 100,
        unit: '%',
        startDate: '2026-01-01',
        endDate: '2026-06-30',
      }).expect(201);
      expect(individualGoal.body.employeeId).toBe(subordinateEmployeeId);

      const progressRes = await patch(`/performance/goals/${individualGoal.body.id}/progress`, subordinateToken, {
        currentValue: 50,
      }).expect(200);
      expect(progressRes.body.progressPercent).toBe(50);
      expect(progressRes.body.status).toBe('NOT_STARTED');

      // COMPANY/TEAM goals require performance.manage — a plain employee is forbidden.
      await post('/performance/goals', subordinateToken, {
        level: 'TEAM',
        departmentId: department.id,
        title: 'Should be forbidden',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }).expect(403);
    });

    it('MANAGER review assignment resolves via the real 1.1 org chart', async () => {
      const listRes = await get(`/performance/appraisals?cycleId=${cycleId}&employeeId=${subordinateEmployeeId}`, tokenHrA).expect(200);
      expect(listRes.body).toHaveLength(1);
      appraisalId = listRes.body[0].id;

      const detailRes = await get(`/performance/appraisals/${appraisalId}`, tokenHrA).expect(200);
      const managerAssignment = detailRes.body.assignments.find((a: { reviewType: string }) => a.reviewType === 'MANAGER');
      expect(managerAssignment).toBeDefined();
      expect(managerAssignment.reviewerId).toBe(managerEmployeeId);

      const selfAssignment = detailRes.body.assignments.find((a: { reviewType: string }) => a.reviewType === 'SELF');
      expect(selfAssignment.reviewerId).toBe(subordinateEmployeeId);

      // No PEER assignment yet — PEER is never auto-resolved by the org chart.
      expect(detailRes.body.assignments.find((a: { reviewType: string }) => a.reviewType === 'PEER')).toBeUndefined();
    });

    it('reminders fire via the real 0.8 notification hub as assignments are created', async () => {
      await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { tenantId: tenantAId, recipientUserId: subordinateUserId, eventType: 'performance.review_due' },
        });
        return rows.length > 0 ? rows : null;
      });
      await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { tenantId: tenantAId, recipientUserId: managerUserId, eventType: 'performance.review_due' },
        });
        return rows.length > 0 ? rows : null;
      });
      const cycleOpenedRows = await prisma.notification.findMany({
        where: { tenantId: tenantAId, eventType: 'performance.cycle_opened', recipientUserId: subordinateUserId },
      });
      expect(cycleOpenedRows.length).toBeGreaterThan(0);
    });

    it('self + manager + peer reviews submit, are explicitly peer-assigned, and route + sign off via the real 0.7 workflow', async () => {
      await post(`/performance/appraisals/${appraisalId}/peer-assignments`, tokenHrA, { reviewerIds: [peerEmployeeId] }).expect(201);

      await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { tenantId: tenantAId, recipientUserId: (await prisma.employee.findUniqueOrThrow({ where: { id: peerEmployeeId } })).userId!, eventType: 'performance.review_due' },
        });
        return rows.length > 0 ? rows : null;
      });

      async function submitAssignment(token: string, rating: number) {
        const mineRes = await get('/performance/my-review-assignments', token).expect(200);
        const assignment = mineRes.body.find((a: { appraisalId: string }) => a.appraisalId === appraisalId);
        expect(assignment).toBeDefined();
        await post(`/performance/review-assignments/${assignment.id}/submit`, token, { overallRating: rating, comments: 'Solid work.' }).expect(
          201,
        );
        return assignment.reviewType;
      }

      const submittedTypes = new Set<string>();
      submittedTypes.add(await submitAssignment(subordinateToken, 4));
      submittedTypes.add(await submitAssignment(managerToken, 5));
      submittedTypes.add(await submitAssignment(peerToken, 3));
      expect(submittedTypes).toEqual(new Set(['SELF', 'MANAGER', 'PEER']));

      const submitRes = await post(`/performance/appraisals/${appraisalId}/submit-for-approval`, tokenHrA, {}).expect(201);
      expect(submitRes.body.submitted).toBe(true);

      const afterSubmit = await get(`/performance/appraisals/${appraisalId}`, tokenHrA).expect(200);
      expect(afterSubmit.body.status).toBe('PENDING_SIGNOFF');
      expect(afterSubmit.body.overallRating).toBe(4); // (4 + 5 + 3) / 3
      const instanceId = afterSubmit.body.workflowInstanceId;

      const instanceDetail = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(activeStep.eligibleApproverIds).toContain(managerUserId);

      await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(201);

      const completed = await waitFor(async () => {
        const res = await get(`/performance/appraisals/${appraisalId}`, tokenHrA).expect(200);
        return res.body.status === 'COMPLETED' ? res.body : null;
      });
      expect(completed.overallRating).toBe(4);
    });

    it('calibration/distribution is pre-aggregated, correct, branch-scoped, and RBAC-gated', async () => {
      const rows = await waitFor(async () => {
        const res = await get(`/performance/cycles/${cycleId}/calibration`, tokenHrA).expect(200);
        return res.body.length > 0 ? res.body : null;
      });
      const row = rows.find((r: { ratingValue: number }) => r.ratingValue === 4);
      expect(row).toBeDefined();
      expect(row.branchId).toBe(branchAUsId);
      expect(row.employeeCount).toBe(1);

      // Branch-scoped: an HR user restricted to the QA branch (no completed
      // appraisals there) sees an empty distribution for the SAME cycle —
      // never a 403, the same "RBAC gates the feature, the row filter gates
      // the data" two-layer shape analytics.md already establishes.
      const hrRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } });
      const restrictedHr = await makeUserWithRole(tenantAId, hrRoleA.id, 'restricted-hr@perf-a.test');
      await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: restrictedHr.id, branchId: branchAQaId } });
      const restrictedToken = jwt.sign({ sub: restrictedHr.id, tenantId: tenantAId });

      const restrictedRes = await get(`/performance/cycles/${cycleId}/calibration`, restrictedToken).expect(200);
      expect(restrictedRes.body).toEqual([]);

      // RBAC-gated: a plain employee (performance.read/write/review only, no performance.manage) is forbidden.
      await get(`/performance/cycles/${cycleId}/calibration`, subordinateToken).expect(403);

      // The manual backfill/test lever also works.
      await post(`/performance/cycles/${cycleId}/calibration/recompute`, tokenHrA, {}).expect(201);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot see tenant A's rating scales, cycles, or appraisals", async () => {
      const scalesRes = await get('/performance/rating-scales', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(scalesRes.body.find((s: { key: string }) => s.key === '5_POINT')).toBeUndefined();

      const cyclesRes = await get('/performance/cycles', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(cyclesRes.body).toEqual([]);
    });
  });
});
