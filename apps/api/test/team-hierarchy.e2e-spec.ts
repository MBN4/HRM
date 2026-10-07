/**
 * Proves step 7.2 (hierarchical team approvals) end to end over real HTTP +
 * Postgres + Redis — see docs/conventions/team-hierarchy-approvals.md.
 *
 * Chain under test:  intern -> lead -> pm -> (no manager) -> CEO
 *
 * A JWT is minted directly (same rationale every other e2e suite documents).
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
const SLUG_A = 'hier-test-a';
const SLUG_B = 'hier-test-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;

interface Person {
  id: string;
  email: string;
  token: string;
  employeeId: string;
}

describe('team hierarchy approvals (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;
  let branchBId: string;
  const roleA: Record<string, string> = {};
  const roleB: Record<string, string> = {};

  let admin: Person;
  let hr: Person;
  let ceo: Person;
  let pm: Person;
  let lead: Person;
  let intern: Person;
  let adminB: Person;
  let counter = 0;
  // Leave dates must not overlap between submissions for the same person.
  let dayCursor = 0;

  const call = (slug: string, token: string) => ({
    get: (url: string) => request(app.getHttpServer()).get(url).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
    post: (url: string) => request(app.getHttpServer()).post(url).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => request(app.getHttpServer()).patch(url).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
  });
  const A = (p: Person) => call(SLUG_A, p.token);

  async function makePerson(
    tenantId: string,
    email: string,
    roleIds: string[],
    managerId: string | null,
    branchId = branchAId,
  ): Promise<Person> {
    counter += 1;
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE', managerId } });
    for (const roleId of roleIds) await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        branchId,
        userId: user.id,
        employeeCode: `H-${counter}-${Date.now() % 100000}`,
        firstName: email.split('@')[0],
        lastName: 'Test',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });
    return { id: user.id, email, token: jwt.sign({ sub: user.id, tenantId }), employeeId: employee.id };
  }

  async function submitLeave(person: Person) {
    dayCursor += 1;
    // A fresh Monday-Friday-safe single day per call: Mondays in 2027, spaced a week apart.
    const day = new Date(Date.UTC(2027, 0, 4 + 7 * dayCursor)).toISOString().slice(0, 10);
    await A(hr).post(`/leave/balances/${person.employeeId}/adjust`).send({ leaveType: 'ANNUAL', deltaDays: 5, periodYear: 2027 }).expect(201);
    const res = await A(person).post('/leave/requests').send({ leaveType: 'ANNUAL', startDate: day, endDate: day }).expect(201);
    return res.body as { id: string; workflowInstanceId: string };
  }

  async function activeStep(viewer: Person, instanceId: string) {
    const res = await A(viewer).get(`/workflow/instances/${instanceId}`).expect(200);
    const step = res.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
    return { step, instance: res.body.instance, steps: res.body.steps as { status: string }[] };
  }

  const act = (actor: Person, instanceId: string, stepId: string, actionType: 'APPROVE' | 'REJECT') =>
    A(actor).post(`/workflow/instances/${instanceId}/steps/${stepId}/actions`).send({ actionType });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);
    const a = await prisma.tenant.create({ data: { name: 'Hier A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    const b = await prisma.tenant.create({ data: { name: 'Hier B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    tenantAId = a.id;
    tenantBId = b.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    for (const [tid, map] of [[tenantAId, roleA], [tenantBId, roleB]] as const) {
      for (const r of await prisma.role.findMany({ where: { tenantId: tid } })) map[r.name] = r.id;
    }
    branchAId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'HQ', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchBId = (await prisma.branch.create({ data: { tenantId: tenantBId, name: 'HQ-B', countryCode: 'US', timezone: 'America/New_York' } })).id;

    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Leave Approval', entityType: LEAVE_REQUEST_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: template.id, name: 'Manager approval', order: 1, approverRule: { type: 'MANAGER' } },
    });

    admin = await makePerson(tenantAId, 'admin@hier-a.test', [roleA[SYSTEM_ROLES.TENANT_ADMIN]], null);
    hr = await makePerson(tenantAId, 'hr@hier-a.test', [roleA[SYSTEM_ROLES.HR_MANAGER]], null);
    ceo = await makePerson(tenantAId, 'ceo@hier-a.test', [roleA[SYSTEM_ROLES.CEO]], null);
    // pm is the org head: NO manager -> routes to the CEO.
    pm = await makePerson(tenantAId, 'pm@hier-a.test', [roleA[SYSTEM_ROLES.MANAGER]], null);
    lead = await makePerson(tenantAId, 'lead@hier-a.test', [roleA[SYSTEM_ROLES.MANAGER]], pm.id);
    intern = await makePerson(tenantAId, 'intern@hier-a.test', [roleA[SYSTEM_ROLES.EMPLOYEE]], lead.id);
    adminB = await makePerson(tenantBId, 'admin@hier-b.test', [roleB[SYSTEM_ROLES.TENANT_ADMIN]], null, branchBId);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('the chain', () => {
    it("an intern's leave goes to their DIRECT manager (the lead), who approves it", async () => {
      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([lead.id]);
      expect(step.routing.kind).toBe('DIRECT_MANAGER');

      await act(lead, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
      const after = await activeStep(intern, req.workflowInstanceId);
      expect(after.instance.status).toBe('APPROVED');
    });

    it("a lead's OWN leave goes to THEIR manager (the PM) — never to the lead", async () => {
      const req = await submitLeave(lead);
      const { step } = await activeStep(lead, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([pm.id]);
      await act(lead, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      await act(intern, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      await act(pm, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
    });

    it('the TOP of the chain (the PM, no manager) routes to the CEO', async () => {
      const req = await submitLeave(pm);
      const { step } = await activeStep(pm, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([ceo.id]);
      expect(step.routing.kind).toBe('CEO_TOP_OF_CHAIN');
      await act(pm, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      await act(ceo, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
    });
  });

  describe('CEO authority + self-approval', () => {
    it('the CEO can approve ANY request, even one addressed to someone else', async () => {
      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([lead.id]);
      await act(ceo, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
      expect((await activeStep(intern, req.workflowInstanceId)).instance.status).toBe('APPROVED');
    });

    it('a non-CEO outside the chain still cannot (admin rights do not make you an approver)', async () => {
      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      await act(admin, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      await act(lead, req.workflowInstanceId, step.id, 'REJECT').expect(201); // tidy up
    });

    it("nobody approves their OWN request — not even the CEO — it always goes up", async () => {
      // The CEO's own leave: no other CEO exists, so it falls back to a tenant admin.
      const req = await submitLeave(ceo);
      const { step } = await activeStep(ceo, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([admin.id]);
      expect(step.routing.kind).toBe('ADMIN_FALLBACK');
      await act(ceo, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      await act(admin, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
    });

    it('self-approval is blocked in the engine even when a rule names the requester', async () => {
      const template = await prisma.workflowTemplate.create({
        data: { tenantId: tenantAId, name: 'Self test', entityType: 'SELF_TEST', version: 1, isActive: true },
      });
      await prisma.workflowStep.create({
        data: { tenantId: tenantAId, templateId: template.id, name: 'Admin sign-off', order: 1, approverRule: { type: 'ROLE', roleName: 'TENANT_ADMIN' } },
      });
      const started = await A(admin)
        .post('/workflow/instances')
        .send({ entityType: 'SELF_TEST', entityId: '11111111-1111-4111-8111-111111111111', dataSnapshot: {} })
        .expect(201);
      const { step } = await activeStep(admin, started.body.id);
      expect(step.eligibleApproverIds).not.toContain(admin.id);
      await act(admin, started.body.id, step.id, 'APPROVE').expect(403);
    });
  });

  describe('HR administers — it never approves', () => {
    it('HR can manage users/employees/leave balances (admin rights are intact)', async () => {
      await A(hr).get('/users').expect(200);
      await A(hr).get('/users/hierarchy').expect(200);
      await A(hr).get(`/leave/balances?employeeId=${intern.employeeId}&year=2027`).expect(200);
    });

    it('HR cannot approve: 403 on a step, even a step addressed by an explicit HR ROLE rule', async () => {
      const req = await submitLeave(intern);
      const { step } = await activeStep(hr, req.workflowInstanceId);
      const denied = await act(hr, req.workflowInstanceId, step.id, 'APPROVE').expect(403);
      expect(denied.body.message).toMatch(/HR/);
      await act(hr, req.workflowInstanceId, step.id, 'REJECT').expect(403);

      const template = await prisma.workflowTemplate.create({
        data: { tenantId: tenantAId, name: 'HR rule', entityType: 'HR_RULE_TEST', version: 1, isActive: true },
      });
      await prisma.workflowStep.create({
        data: { tenantId: tenantAId, templateId: template.id, name: 'HR sign-off', order: 1, approverRule: { type: 'ROLE', roleName: 'HR_MANAGER' } },
      });
      const started = await A(intern)
        .post('/workflow/instances')
        .send({ entityType: 'HR_RULE_TEST', entityId: '22222222-2222-4222-8222-222222222222', dataSnapshot: {} })
        .expect(201);
      const hrStep = (await activeStep(intern, started.body.id)).step;
      expect(hrStep.eligibleApproverIds).toEqual([]); // HR never appears as an approver
      await act(hr, started.body.id, hrStep.id, 'APPROVE').expect(403);
    });

    it('HR never receives approvals in their inbox, and cannot be delegated to', async () => {
      const inbox = await A(hr).get('/workflow/my-pending-approvals').expect(200);
      expect(inbox.body).toEqual([]);

      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      await A(lead).post(`/workflow/instances/${req.workflowInstanceId}/steps/${step.id}/actions`).send({ actionType: 'DELEGATE', delegatedToUserId: hr.id }).expect(400);
    });

    it('an HR user placed IN the chain is skipped — approval escalates past them', async () => {
      const hrTeamLead = await makePerson(tenantAId, 'hr-lead@hier-a.test', [roleA[SYSTEM_ROLES.HR_MANAGER]], pm.id);
      const hrReport = await makePerson(tenantAId, 'hr-report@hier-a.test', [roleA[SYSTEM_ROLES.EMPLOYEE]], hrTeamLead.id);
      const req = await submitLeave(hrReport);
      const { step } = await activeStep(hrReport, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([pm.id]);
      expect(step.routing.kind).toBe('ESCALATED_MANAGER_UNAVAILABLE');
      expect(step.routing.skipped[0]).toMatchObject({ userId: hrTeamLead.id, why: 'HR_EXCLUDED' });
      await act(pm, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
    });
  });

  describe('manager absent / left -> escalate up the chain', () => {
    it('deactivating the lead escalates the intern\'s PENDING request to the PM, instantly', async () => {
      const req = await submitLeave(intern);
      expect((await activeStep(intern, req.workflowInstanceId)).step.eligibleApproverIds).toEqual([lead.id]);

      await A(admin).post(`/users/${lead.id}/deactivate`).expect(200);

      const { step } = await activeStep(intern, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([pm.id]);
      expect(step.routing.kind).toBe('ESCALATED_MANAGER_UNAVAILABLE');
      expect(step.routing.skipped[0]).toMatchObject({ userId: lead.id, why: 'DEACTIVATED' });

      // ...and a FUTURE request takes the same fallback.
      const future = await submitLeave(intern);
      expect((await activeStep(intern, future.workflowInstanceId)).step.eligibleApproverIds).toEqual([pm.id]);

      // The inbox says WHY.
      const inbox = await A(pm).get('/workflow/my-pending-approvals').expect(200);
      const mine = inbox.body.find((s: { instanceId: string }) => s.instanceId === req.workflowInstanceId);
      expect(mine.viewerReason).toBe('ESCALATED_MANAGER_UNAVAILABLE');
      await act(pm, req.workflowInstanceId, step.id, 'APPROVE').expect(201);

      // Reactivating hands pending requests back to the direct manager.
      await A(admin).post(`/users/${lead.id}/reactivate`).expect(200);
      const back = await activeStep(intern, future.workflowInstanceId);
      expect(back.step.eligibleApproverIds).toEqual([lead.id]);
      expect(back.step.routing.kind).toBe('DIRECT_MANAGER');
      await act(lead, future.workflowInstanceId, back.step.id, 'APPROVE').expect(201);
    });

    it('with lead AND PM both gone, the request lands on the CEO', async () => {
      await A(admin).post(`/users/${lead.id}/deactivate`).expect(200);
      await A(admin).post(`/users/${pm.id}/deactivate`).expect(200);
      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      expect(step.eligibleApproverIds).toEqual([ceo.id]);
      expect(step.routing.kind).toBe('CEO_ESCALATED');
      expect(step.routing.skipped.map((s: { userId: string }) => s.userId)).toEqual([lead.id, pm.id]);
      await act(ceo, req.workflowInstanceId, step.id, 'APPROVE').expect(201);
      await A(admin).post(`/users/${lead.id}/reactivate`).expect(200);
      await A(admin).post(`/users/${pm.id}/reactivate`).expect(200);
    });

    it("a deactivated manager's old access token can no longer approve", async () => {
      const req = await submitLeave(intern);
      const { step } = await activeStep(intern, req.workflowInstanceId);
      await A(admin).post(`/users/${lead.id}/deactivate`).expect(200);
      await act(lead, req.workflowInstanceId, step.id, 'APPROVE').expect(401);
      await A(admin).post(`/users/${lead.id}/reactivate`).expect(200);
      await act(ceo, req.workflowInstanceId, step.id, 'REJECT').expect(201); // tidy up
    });
  });

  describe('setting a manager: cycles, reassignment reroutes, guards', () => {
    it('rejects self-management and any loop (A -> B -> ... -> A)', async () => {
      await A(admin).patch(`/users/${lead.id}/manager`).send({ managerId: lead.id }).expect(400);
      // pm -> intern would close pm -> intern -> lead -> pm
      const loop = await A(admin).patch(`/users/${pm.id}/manager`).send({ managerId: intern.id }).expect(400);
      expect(loop.body.message).toMatch(/loop/i);
      await A(admin).patch(`/users/${pm.id}/manager`).send({ managerId: lead.id }).expect(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: pm.id } })).managerId).toBeNull();
    });

    it('rejects a deactivated or non-existent manager', async () => {
      const gone = await makePerson(tenantAId, 'gone@hier-a.test', [roleA[SYSTEM_ROLES.EMPLOYEE]], null);
      await A(admin).post(`/users/${gone.id}/deactivate`).expect(200);
      await A(admin).patch(`/users/${intern.id}/manager`).send({ managerId: gone.id }).expect(400);
      await A(admin).patch(`/users/${intern.id}/manager`).send({ managerId: '33333333-3333-4333-8333-333333333333' }).expect(400);
    });

    it("reassigning someone's manager reroutes their PENDING approvals and future ones, and is audited", async () => {
      const req = await submitLeave(intern);
      expect((await activeStep(intern, req.workflowInstanceId)).step.eligibleApproverIds).toEqual([lead.id]);

      const res = await A(hr).patch(`/users/${intern.id}/manager`).send({ managerId: pm.id }).expect(200);
      expect(res.body.managerId).toBe(pm.id);
      expect(res.body.manager.email).toBe(pm.email);

      expect((await activeStep(intern, req.workflowInstanceId)).step.eligibleApproverIds).toEqual([pm.id]);
      const future = await submitLeave(intern);
      expect((await activeStep(intern, future.workflowInstanceId)).step.eligibleApproverIds).toEqual([pm.id]);

      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'User', entityId: intern.id, action: 'SET_MANAGER' } });
      expect(audits.length).toBeGreaterThan(0);

      // restore + clean up the open requests
      await A(admin).patch(`/users/${intern.id}/manager`).send({ managerId: lead.id }).expect(200);
      await act(lead, req.workflowInstanceId, (await activeStep(intern, req.workflowInstanceId)).step.id, 'REJECT').expect(201);
      await act(lead, future.workflowInstanceId, (await activeStep(intern, future.workflowInstanceId)).step.id, 'REJECT').expect(201);
    });

    it('a normal member cannot change reporting lines, and nobody can change their own', async () => {
      await A(intern).patch(`/users/${intern.id}/manager`).send({ managerId: pm.id }).expect(403);
      await A(admin).patch(`/users/${admin.id}/manager`).send({ managerId: ceo.id }).expect(403);
      await A(intern).get('/users/hierarchy').expect(403);
    });
  });

  describe('inbox reasons + the hierarchy view', () => {
    it('shows WHY each request is queued: direct report for the manager, CEO override for the CEO', async () => {
      const req = await submitLeave(intern);
      const leadInbox = await A(lead).get('/workflow/my-pending-approvals').expect(200);
      const mine = leadInbox.body.find((s: { instanceId: string }) => s.instanceId === req.workflowInstanceId);
      expect(mine.viewerReason).toBe('DIRECT_MANAGER');

      const ceoInbox = await A(ceo).get('/workflow/my-pending-approvals').expect(200);
      const seen = ceoInbox.body.find((s: { instanceId: string }) => s.instanceId === req.workflowInstanceId);
      expect(seen.viewerReason).toBe('CEO_OVERRIDE');

      const internInbox = await A(intern).get('/workflow/my-pending-approvals').expect(200);
      expect(internInbox.body.find((s: { instanceId: string }) => s.instanceId === req.workflowInstanceId)).toBeUndefined();
      await act(lead, req.workflowInstanceId, (await activeStep(intern, req.workflowInstanceId)).step.id, 'APPROVE').expect(201);
    });

    it('GET /users/hierarchy returns the tree data with who approves each person', async () => {
      const res = await A(hr).get('/users/hierarchy').expect(200);
      const byEmail = Object.fromEntries(res.body.items.map((i: { email: string }) => [i.email, i]));
      expect(byEmail['intern@hier-a.test'].managerId).toBe(lead.id);
      expect(byEmail['intern@hier-a.test'].approvers.map((a: { id: string }) => a.id)).toEqual([lead.id]);
      expect(byEmail['lead@hier-a.test'].approvers.map((a: { id: string }) => a.id)).toEqual([pm.id]);
      expect(byEmail['pm@hier-a.test'].approvers.map((a: { id: string }) => a.id)).toEqual([ceo.id]);
      expect(byEmail['pm@hier-a.test'].routing.kind).toBe('CEO_TOP_OF_CHAIN');
      expect(byEmail['lead@hier-a.test'].directReportCount).toBeGreaterThanOrEqual(1);
      expect(byEmail['ceo@hier-a.test'].roles).toContain('CEO');
    });

    it('create-user accepts a manager and the users list shows it', async () => {
      const res = await A(hr)
        .post('/users')
        .send({ email: 'newbie@hier-a.test', roleIds: [roleA[SYSTEM_ROLES.EMPLOYEE]], managerId: lead.id })
        .expect(201);
      expect(res.body.managerId).toBe(lead.id);
      expect(res.body.manager.email).toBe(lead.email);
    });
  });

  describe('tenant isolation', () => {
    it("tenant B cannot see or change tenant A's hierarchy, nor pick A's users as managers", async () => {
      const bTree = await call(SLUG_B, adminB.token).get('/users/hierarchy').expect(200);
      expect(bTree.body.items.map((i: { email: string }) => i.email)).toEqual(['admin@hier-b.test']);

      await call(SLUG_B, adminB.token).patch(`/users/${intern.id}/manager`).send({ managerId: null }).expect(404);
      const bUser = await makePerson(tenantBId, 'member@hier-b.test', [roleB[SYSTEM_ROLES.EMPLOYEE]], null, branchBId);
      await call(SLUG_B, adminB.token).patch(`/users/${bUser.id}/manager`).send({ managerId: lead.id }).expect(400);
    });

    it("tenant A's CEO has no authority over tenant B's workflow instances", async () => {
      const started = await call(SLUG_B, adminB.token)
        .post('/workflow/instances')
        .send({ entityType: 'NO_TEMPLATE', entityId: '44444444-4444-4444-8444-444444444444', dataSnapshot: {} });
      expect([404]).toContain(started.status);
      const inbox = await call(SLUG_B, adminB.token).get('/workflow/my-pending-approvals').expect(200);
      expect(inbox.body).toEqual([]);
      await call(SLUG_B, ceo.token).get('/workflow/my-pending-approvals').expect(401);
    });
  });
});
