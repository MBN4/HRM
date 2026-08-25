/**
 * Proves the generic workflow/approval engine (0.7) end to end over real
 * HTTP: a sequential leave-style flow, a conditional expense-style flow
 * that branches via the sandboxed condition evaluator, a parallel step
 * requiring every approver, delegation reassigning who may act,
 * escalation on timeout, auto-approval, rejected/canceled terminal
 * states, and — the RLS proof — templates/instances isolated per tenant.
 *
 * Templates/steps are seeded directly via the owner `prisma` client in
 * fixtures, not through an HTTP admin endpoint — this step's API surface
 * is deliberately limited to the five generic routes the brief calls for
 * (start/act/cancel/query); template authoring has no endpoint yet, same
 * as how RBAC roles, country packs, and licenses are all set up as
 * fixtures elsewhere in this test suite.
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { ApproverRule, WorkflowCondition } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { WorkflowEscalationService } from '../src/workflow/workflow-escalation.service';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'wf-test-tenant-a';
const TENANT_B_SLUG = 'wf-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

const SPECIFIC = (userId: string): ApproverRule => ({ type: 'SPECIFIC_USER', userId });
const ROLE = (roleName: string): ApproverRule => ({ type: 'ROLE', roleName });
const MANAGER: ApproverRule = { type: 'MANAGER' };

const amountGreaterThan = (threshold: number): WorkflowCondition => ({
  type: 'compare',
  op: '>',
  left: { type: 'var', name: 'amount' },
  right: { type: 'const', value: threshold },
});
const amountLessOrEqual = (threshold: number): WorkflowCondition => ({
  type: 'compare',
  op: '<=',
  left: { type: 'var', name: 'amount' },
  right: { type: 'const', value: threshold },
});

describe('workflow engine (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let hrRoleAId: string;

  let employeeId: string;
  let managerId: string;
  let hrUserId: string;
  let approverAId: string;
  let approverBId: string;
  let escalationTargetId: string;

  let employeeToken: string;
  let managerToken: string;
  let hrToken: string;
  let approverAToken: string;
  let approverBToken: string;
  let escalationTargetToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Workflow Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Workflow Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const hrRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } },
    });
    hrRoleAId = hrRoleA.id;
    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });

    const makeUser = async (email: string, roleId: string, managerUserId?: string) => {
      const user = await prisma.user.create({
        data: { tenantId: tenantAId, email, hashedPassword: 'unused', status: 'ACTIVE', managerId: managerUserId },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: user.id, roleId } });
      return user;
    };

    const manager = await makeUser('manager@wf-a.test', employeeRoleA.id);
    managerId = manager.id;
    const employee = await makeUser('employee@wf-a.test', employeeRoleA.id, managerId);
    employeeId = employee.id;
    const hrUser = await makeUser('hr@wf-a.test', hrRoleAId);
    hrUserId = hrUser.id;
    const approverA = await makeUser('approver-a@wf-a.test', employeeRoleA.id);
    approverAId = approverA.id;
    const approverB = await makeUser('approver-b@wf-a.test', employeeRoleA.id);
    approverBId = approverB.id;
    const escalationTarget = await makeUser('escalation-target@wf-a.test', employeeRoleA.id);
    escalationTargetId = escalationTarget.id;

    employeeToken = jwt.sign({ sub: employeeId, tenantId: tenantAId });
    managerToken = jwt.sign({ sub: managerId, tenantId: tenantAId });
    hrToken = jwt.sign({ sub: hrUserId, tenantId: tenantAId });
    approverAToken = jwt.sign({ sub: approverAId, tenantId: tenantAId });
    approverBToken = jwt.sign({ sub: approverBId, tenantId: tenantAId });
    escalationTargetToken = jwt.sign({ sub: escalationTargetId, tenantId: tenantAId });

    // --- Templates -----------------------------------------------------

    async function createTemplate(entityType: string, steps: Array<Record<string, unknown>>) {
      const template = await prisma.workflowTemplate.create({
        data: { tenantId: tenantAId, name: entityType, entityType, version: 1, isActive: true },
      });
      for (const step of steps) {
        await prisma.workflowStep.create({ data: { tenantId: tenantAId, templateId: template.id, ...step } });
      }
      return template;
    }

    // Sequential: manager -> HR.
    await createTemplate('LEAVE_REQUEST', [
      { name: 'Manager approval', order: 1, approverRule: MANAGER },
      { name: 'HR approval', order: 2, approverRule: ROLE(SYSTEM_ROLES.HR_MANAGER) },
    ]);

    // Conditional: manager always; HR only if amount > 1000.
    await createTemplate('EXPENSE_CLAIM', [
      { name: 'Manager approval', order: 1, approverRule: MANAGER },
      { name: 'HR approval (large amounts only)', order: 2, approverRule: ROLE(SYSTEM_ROLES.HR_MANAGER), condition: amountGreaterThan(1000) },
    ]);

    // Parallel: approver A and B share order 1 — BOTH must approve.
    await createTemplate('PARALLEL_APPROVAL', [
      { name: 'Approver A', order: 1, approverRule: SPECIFIC(approverAId) },
      { name: 'Approver B', order: 1, approverRule: SPECIFIC(approverBId) },
    ]);

    // Escalation: approver A, escalates to escalationTarget after timeout.
    await createTemplate('ESCALATION_DEMO', [
      {
        name: 'Approver A (escalates)',
        order: 1,
        approverRule: SPECIFIC(approverAId),
        escalationAfterMinutes: 60,
        escalationRule: SPECIFIC(escalationTargetId),
      },
    ]);

    // Delegation: approver A, freely delegatable.
    await createTemplate('DELEGATION_DEMO', [{ name: 'Approver A', order: 1, approverRule: SPECIFIC(approverAId) }]);

    // Auto-approval: small amounts need no human.
    await createTemplate('AUTO_APPROVE_DEMO', [
      { name: 'Manager approval (auto for small amounts)', order: 1, approverRule: MANAGER, autoApproveCondition: amountLessOrEqual(50) },
    ]);
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function start(token: string, body: unknown) {
    return request(app.getHttpServer())
      .post('/workflow/instances')
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getInstance(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/workflow/instances/${id}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${token}`);
  }

  function act(token: string, instanceId: string, stepId: string, body: unknown) {
    return request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/steps/${stepId}/actions`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function cancel(token: string, instanceId: string) {
    return request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/cancel`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${token}`);
  }

  function myPendingApprovals(token: string) {
    return request(app.getHttpServer())
      .get('/workflow/my-pending-approvals')
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${token}`);
  }

  function activeStep(steps: Array<{ status: string; name: string }>, name: string) {
    return steps.find((s) => s.name === name && s.status === 'ACTIVE');
  }

  describe('sequential leave-style flow (manager -> HR)', () => {
    it('runs end to end: manager approves, then HR approves, then the instance is APPROVED', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'LEAVE_REQUEST',
        entityId: 'leave-1',
        dataSnapshot: { days: 3, leaveType: 'ANNUAL' },
      }).expect(201);
      const instanceId = startRes.body.id;
      expect(startRes.body.status).toBe('IN_STEP');

      let detail = await getInstance(employeeToken, instanceId).expect(200);
      const managerStep = activeStep(detail.body.steps, 'Manager approval');
      expect(managerStep).toBeDefined();

      // The requester themselves is not an eligible approver.
      await act(employeeToken, instanceId, managerStep!.id, { actionType: 'APPROVE' }).expect(403);

      await act(managerToken, instanceId, managerStep!.id, { actionType: 'APPROVE', comment: 'looks fine' }).expect(201);

      detail = await getInstance(employeeToken, instanceId).expect(200);
      expect(detail.body.instance.status).toBe('IN_STEP');
      const hrStep = activeStep(detail.body.steps, 'HR approval');
      expect(hrStep).toBeDefined();

      await act(hrToken, instanceId, hrStep!.id, { actionType: 'APPROVE' }).expect(201);

      detail = await getInstance(employeeToken, instanceId).expect(200);
      expect(detail.body.instance.status).toBe('APPROVED');
      expect(detail.body.instance.completedAt).not.toBeNull();

      const actionTypes = detail.body.actions.map((a: { actionType: string }) => a.actionType);
      expect(actionTypes).toEqual(['APPROVE', 'APPROVE']);
    });
  });

  describe('conditional expense-style flow (amount <= X vs. amount > X)', () => {
    it('a small amount only needs manager approval — the HR step is SKIPPED', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'EXPENSE_CLAIM',
        entityId: 'expense-small',
        dataSnapshot: { amount: 500 },
      }).expect(201);
      const instanceId = startRes.body.id;

      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const hrStep = detail.body.steps.find((s: { name: string }) => s.name === 'HR approval (large amounts only)');
      expect(hrStep.status).toBe('SKIPPED');
      const managerStep = activeStep(detail.body.steps, 'Manager approval');

      await act(managerToken, instanceId, managerStep!.id, { actionType: 'APPROVE' }).expect(201);

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('APPROVED');
    });

    it('a large amount ADDS the HR step, branching correctly via the sandboxed condition evaluator', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'EXPENSE_CLAIM',
        entityId: 'expense-large',
        dataSnapshot: { amount: 5000 },
      }).expect(201);
      const instanceId = startRes.body.id;

      let detail = await getInstance(employeeToken, instanceId).expect(200);
      const managerStep = activeStep(detail.body.steps, 'Manager approval');
      await act(managerToken, instanceId, managerStep!.id, { actionType: 'APPROVE' }).expect(201);

      detail = await getInstance(employeeToken, instanceId).expect(200);
      expect(detail.body.instance.status).toBe('IN_STEP');
      const hrStep = activeStep(detail.body.steps, 'HR approval (large amounts only)');
      expect(hrStep).toBeDefined();

      await act(hrToken, instanceId, hrStep!.id, { actionType: 'APPROVE' }).expect(201);
      detail = await getInstance(employeeToken, instanceId).expect(200);
      expect(detail.body.instance.status).toBe('APPROVED');
    });
  });

  describe('parallel step requires ALL parallel approvers', () => {
    it('does not advance until BOTH approver A and approver B approve', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'PARALLEL_APPROVAL',
        entityId: 'parallel-1',
        dataSnapshot: {},
      }).expect(201);
      const instanceId = startRes.body.id;

      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const stepA = activeStep(detail.body.steps, 'Approver A');
      const stepB = activeStep(detail.body.steps, 'Approver B');
      expect(stepA).toBeDefined();
      expect(stepB).toBeDefined();

      await act(approverAToken, instanceId, stepA!.id, { actionType: 'APPROVE' }).expect(201);

      const midDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(midDetail.body.instance.status).toBe('IN_STEP'); // still waiting on B

      await act(approverBToken, instanceId, stepB!.id, { actionType: 'APPROVE' }).expect(201);

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('APPROVED');
    });
  });

  describe('delegation reassigns who may act', () => {
    it('the delegate can approve; the original approver no longer can', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'DELEGATION_DEMO',
        entityId: 'delegate-1',
        dataSnapshot: {},
      }).expect(201);
      const instanceId = startRes.body.id;
      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const step = activeStep(detail.body.steps, 'Approver A')!;

      await act(approverAToken, instanceId, step.id, { actionType: 'DELEGATE', delegatedToUserId: approverBId }).expect(
        201,
      );

      await act(approverAToken, instanceId, step.id, { actionType: 'APPROVE' }).expect(403);
      await act(approverBToken, instanceId, step.id, { actionType: 'APPROVE' }).expect(201);

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('APPROVED');
      const actionTypes = finalDetail.body.actions.map((a: { actionType: string }) => a.actionType);
      expect(actionTypes).toEqual(['DELEGATE', 'APPROVE']);
    });
  });

  describe('escalation on timeout', () => {
    it('fires once the step is overdue, reassigning to the escalation target', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'ESCALATION_DEMO',
        entityId: 'escalate-1',
        dataSnapshot: {},
      }).expect(201);
      const instanceId = startRes.body.id;
      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const step = activeStep(detail.body.steps, 'Approver A (escalates)')!;

      // Simulate the escalation deadline having already elapsed.
      await prisma.workflowInstanceStep.update({ where: { id: step.id }, data: { dueAt: new Date(Date.now() - 60_000) } });

      const escalation = moduleRef.get(WorkflowEscalationService);
      const { escalatedCount } = await escalation.sweepOverdueSteps();
      expect(escalatedCount).toBeGreaterThanOrEqual(1);

      const escalatedDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(escalatedDetail.body.instance.status).toBe('ESCALATED');
      expect(escalatedDetail.body.actions.map((a: { actionType: string }) => a.actionType)).toContain('ESCALATE');

      // The original approver can no longer act; the escalation target now can.
      await act(approverAToken, instanceId, step.id, { actionType: 'APPROVE' }).expect(403);

      const pending = await myPendingApprovals(escalationTargetToken).expect(200);
      expect(pending.body.some((s: { id: string }) => s.id === step.id)).toBe(true);

      await act(escalationTargetToken, instanceId, step.id, { actionType: 'APPROVE' }).expect(201);

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('APPROVED');
    });
  });

  describe('auto-approval rules', () => {
    it('a step whose autoApproveCondition is true resolves with no human action at all', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'AUTO_APPROVE_DEMO',
        entityId: 'auto-1',
        dataSnapshot: { amount: 10 },
      }).expect(201);
      expect(startRes.body.status).toBe('APPROVED');

      const detail = await getInstance(employeeToken, startRes.body.id).expect(200);
      expect(detail.body.steps[0].status).toBe('APPROVED');
      expect(detail.body.actions).toEqual([expect.objectContaining({ actionType: 'AUTO_APPROVE', actorUserId: null })]);
    });
  });

  describe('rejected and canceled terminal states', () => {
    it('a rejection at any step terminates the whole instance as REJECTED', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'LEAVE_REQUEST',
        entityId: 'leave-reject',
        dataSnapshot: { days: 10 },
      }).expect(201);
      const instanceId = startRes.body.id;
      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const managerStep = activeStep(detail.body.steps, 'Manager approval')!;

      await act(managerToken, instanceId, managerStep.id, { actionType: 'REJECT', comment: 'not enough notice' }).expect(
        201,
      );

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('REJECTED');

      // A terminal instance accepts no further actions.
      await act(managerToken, instanceId, managerStep.id, { actionType: 'APPROVE' }).expect(400);
    });

    it('the requester can cancel a still-pending instance, after which no further action is accepted', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'LEAVE_REQUEST',
        entityId: 'leave-cancel',
        dataSnapshot: { days: 2 },
      }).expect(201);
      const instanceId = startRes.body.id;
      const detail = await getInstance(employeeToken, instanceId).expect(200);
      const managerStep = activeStep(detail.body.steps, 'Manager approval')!;

      await cancel(employeeToken, instanceId).expect(201);

      const finalDetail = await getInstance(employeeToken, instanceId).expect(200);
      expect(finalDetail.body.instance.status).toBe('CANCELED');
      expect(finalDetail.body.instance.completedAt).not.toBeNull();

      // The instance-level terminal status is authoritative — a step that was ACTIVE the moment
      // cancellation happened is frozen in that state for audit (same "fail-fast, sibling status
      // isn't rewritten" posture as a rejection — see WorkflowEngineService.actOnStep), but the
      // terminal-instance guard blocks any further action on it regardless.
      await act(managerToken, instanceId, managerStep.id, { actionType: 'APPROVE' }).expect(400);
    });

    it('a non-requester without workflow.manage cannot cancel someone else\'s instance', async () => {
      const startRes = await start(employeeToken, {
        entityType: 'LEAVE_REQUEST',
        entityId: 'leave-cancel-2',
        dataSnapshot: { days: 1 },
      }).expect(201);

      await cancel(managerToken, startRes.body.id).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot resolve tenant A's template (no active template for that entity type in B)", async () => {
      const tenantBAdminRole = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
      });
      const tenantBUser = await prisma.user.create({
        data: { tenantId: tenantBId, email: 'admin@wf-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantBId, userId: tenantBUser.id, roleId: tenantBAdminRole.id } });
      const tenantBToken = jwt.sign({ sub: tenantBUser.id, tenantId: tenantBId });

      const res = await request(app.getHttpServer())
        .post('/workflow/instances')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tenantBToken}`)
        .send({ entityType: 'LEAVE_REQUEST', entityId: 'cross-tenant-leave', dataSnapshot: { days: 1 } })
        .expect(404);
      expect(res.body.message).toMatch(/no active workflow template/i);
    });

    it("tenant A's instance is invisible to a caller resolved under tenant B's context", async () => {
      const startRes = await start(employeeToken, {
        entityType: 'LEAVE_REQUEST',
        entityId: 'leave-cross-tenant-check',
        dataSnapshot: { days: 1 },
      }).expect(201);

      const tenantBUser = await prisma.user.findFirstOrThrow({ where: { tenantId: tenantBId, email: 'admin@wf-b.test' } });
      const tenantBToken = jwt.sign({ sub: tenantBUser.id, tenantId: tenantBId });

      await request(app.getHttpServer())
        .get(`/workflow/instances/${startRes.body.id}`)
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tenantBToken}`)
        .expect(404);
    });
  });
});
