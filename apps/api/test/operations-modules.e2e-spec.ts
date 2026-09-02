/**
 * Proves the four operations modules (step 3.1, Phase 3's first slice) end
 * to end over real HTTP — see docs/conventions/operations-modules.md:
 * Expenses & Reimbursements (a conditional, amount-thresholded approval via
 * the REAL 0.7 workflow engine, a policy-limit rejection, and a real
 * Payroll reimbursement hand-off with a genuine multi-currency rollup),
 * Asset Management (assign/return lifecycle, and the offboarding clearance
 * checklist's real "asset return" wiring — a task that used to be a
 * placeholder tick-box now genuinely blocked while an asset is still
 * outstanding), HR Helpdesk (ticket lifecycle + a real SLA-breach
 * escalation notification), and Announcements & Policies (branch targeting
 * and e-acknowledgment tracking). Every module's own approval/notification/
 * isolation logic is reused, never reimplemented — see THE RULE in
 * docs/conventions/workflow.md.
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
import type { ApproverRule, WorkflowCondition } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { EXPENSE_CLAIM_ENTITY_TYPE } from '../src/expenses/expenses.constants';
import { OFFBOARDING_PROCESS_ENTITY_TYPE } from '../src/offboarding/offboarding.constants';
import { TicketSlaService } from '../src/helpdesk/ticket-sla.service';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'ops-test-tenant-a';
const TENANT_B_SLUG = 'ops-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 200): Promise<T> {
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

const MANAGER: ApproverRule = { type: 'MANAGER' };
const ROLE = (roleName: string): ApproverRule => ({ type: 'ROLE', roleName });
const amountGreaterThan = (threshold: number): WorkflowCondition => ({
  type: 'compare',
  op: '>',
  left: { type: 'var', name: 'amount' },
  right: { type: 'const', value: threshold },
});

describe('operations modules (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchQaId: string;
  let branchUsId: string;
  // A DEDICATED branch for the reimbursement-hand-off scenario, so its
  // `PayrollRunProcessor` run only ever sees the ONE employee it's testing
  // — the shared `branchQaId` accumulates several other employees across
  // the Expenses describe block's other tests, none of which have
  // compensation set, which would otherwise leave the run permanently
  // short of `CALCULATED` (every line must COMPUTE, not just this one).
  let branchQaPayrollId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenAdminB: string;

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }
  function patch(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).patch(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  let empCounter = 0;
  async function makeEmployee(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    empCounter += 1;
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `OPS-${empCounter}`,
        firstName: 'Fixture',
        lastName: `Employee${empCounter}`,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2026-01-01'),
        status: 'ACTIVE',
        ...overrides,
      },
    });
  }

  async function makeManagerAndReport(tenantId: string, branchId: string, statutoryFields: Record<string, string> = {}) {
    const employeeRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const managerUser = await makeUserWithRole(tenantId, employeeRole.id, `manager-${empCounter + 1}@ops-a.test`);
    const managerEmployee = await makeEmployee(tenantId, branchId, { userId: managerUser.id, statutoryFields });
    const reportUser = await makeUserWithRole(tenantId, employeeRole.id, `report-${empCounter + 1}@ops-a.test`);
    const reportEmployee = await makeEmployee(tenantId, branchId, { userId: reportUser.id, managerId: managerEmployee.id, statutoryFields });
    return { managerUser, managerEmployee, reportUser, reportEmployee, reportToken: jwt.sign({ sub: reportUser.id, tenantId }), managerToken: jwt.sign({ sub: managerUser.id, tenantId }) };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);
    await prisma.exchangeRate.upsert({
      where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency: 'QAR', quoteCurrency: 'USD', asOfDate: new Date('2026-01-01') } },
      update: { rate: '0.2747' },
      create: { baseCurrency: 'QAR', quoteCurrency: 'USD', rate: '0.2747', asOfDate: new Date('2026-01-01') },
    });

    const tenantA = await prisma.tenant.create({
      data: { name: 'Ops Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', baseCurrencyCode: 'USD' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Ops Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    // FINAL_SETTLEMENT / reimbursement runs still go through
    // `multi_country_payroll` (ENTERPRISE-only) — the SAME per-tenant admin
    // lever payroll.e2e-spec.ts/recruitment-lifecycle.e2e-spec.ts use.
    await prisma.tenantFeatureFlagOverride.create({ data: { tenantId: tenantAId, flagKey: 'multi_country_payroll', enabled: true } });

    const branchQa = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Ops A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } });
    branchQaId = branchQa.id;
    const branchUs = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Ops A US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchUsId = branchUs.id;
    const branchQaPayroll = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Ops A Doha Payroll Office', countryCode: 'QA', timezone: 'Asia/Qatar' } });
    branchQaPayrollId = branchQaPayroll.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const hrRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@ops-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@ops-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@ops-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // The EXPENSE_CLAIM approval template — manager always, HR only above
    // 1000 in the claim's own currency — literally the SAME entityType/
    // shape workflow.e2e-spec.ts's own reference fixture already uses.
    const expenseTemplate = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Expense Approval', entityType: EXPENSE_CLAIM_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: expenseTemplate.id, name: 'Manager approval', order: 1, approverRule: MANAGER },
    });
    await prisma.workflowStep.create({
      data: {
        tenantId: tenantAId,
        templateId: expenseTemplate.id,
        name: 'HR approval (large amounts only)',
        order: 2,
        approverRule: ROLE(SYSTEM_ROLES.HR_MANAGER),
        condition: amountGreaterThan(1000),
      },
    });

    const offboardingTemplate = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Offboarding Approval', entityType: OFFBOARDING_PROCESS_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: offboardingTemplate.id, name: 'Manager sign-off', order: 1, approverRule: MANAGER },
    });

    await post('/offboarding/checklist-templates', tokenHrA, {
      processType: 'OFFBOARDING',
      name: 'Default',
      tasks: [{ key: 'asset_return', title: 'Return company assets', category: 'ASSET', assigneeRule: { type: 'ROLE', roleName: 'HR_MANAGER' }, requiresDocument: false }],
    }).expect(201);
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('Expenses & Reimbursements', () => {
    let travelCategoryId: string;
    let mealsCategoryId: string;

    beforeAll(async () => {
      const travel = await post('/expenses/categories', tokenHrA, { code: 'TRAVEL', name: 'Travel' }).expect(201);
      travelCategoryId = travel.body.id;
      const meals = await post('/expenses/categories', tokenHrA, { code: 'MEALS', name: 'Meals', policyLimitAmount: 500 }).expect(201);
      mealsCategoryId = meals.body.id;
    });

    it('a small claim only needs manager approval — the HR step is SKIPPED', async () => {
      const { reportToken, managerToken } = await makeManagerAndReport(tenantAId, branchQaId, { QATAR_ID: 'QID-1', VISA_SPONSORSHIP: 'Employer' });

      const draft = await post('/expenses/claims', reportToken, {}).expect(201);
      await post(`/expenses/claims/${draft.body.id}/lines`, reportToken, {
        categoryId: travelCategoryId,
        description: 'Taxi',
        amount: 300,
        expenseDate: '2026-06-01',
      }).expect(201);

      const submitted = await post(`/expenses/claims/${draft.body.id}/submit`, reportToken, {}).expect(201);
      expect(submitted.body.status).toBe('SUBMITTED');

      const detail = await get(`/workflow/instances/${submitted.body.workflowInstanceId}`, managerToken).expect(200);
      const hrStep = detail.body.steps.find((s: { name: string }) => s.name === 'HR approval (large amounts only)');
      expect(hrStep.status).toBe('SKIPPED');
      const managerStep = detail.body.steps.find((s: { name: string; status: string }) => s.name === 'Manager approval' && s.status === 'ACTIVE');

      await post(`/workflow/instances/${submitted.body.workflowInstanceId}/steps/${managerStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(201);

      const approved = await waitFor(async () => {
        const claim = await get(`/expenses/claims/${draft.body.id}`, reportToken).expect(200);
        return claim.body.status === 'APPROVED' ? claim.body : null;
      });
      expect(approved.status).toBe('APPROVED');
    });

    it('a line exceeding its category policy limit is rejected at submission', async () => {
      const { reportToken } = await makeManagerAndReport(tenantAId, branchQaId, { QATAR_ID: 'QID-2', VISA_SPONSORSHIP: 'Employer' });

      const draft = await post('/expenses/claims', reportToken, {}).expect(201);
      await post(`/expenses/claims/${draft.body.id}/lines`, reportToken, {
        categoryId: mealsCategoryId,
        description: 'Team dinner',
        amount: 600,
        expenseDate: '2026-06-01',
      }).expect(201);

      const res = await post(`/expenses/claims/${draft.body.id}/submit`, reportToken, {}).expect(400);
      expect(res.body.message).toMatch(/policy limit/i);
    });

    describe('a large claim ADDS the HR step and, once fully approved, hands off to a real Payroll reimbursement', () => {
      let claimId: string;
      let reportEmployeeId: string;
      let reportToken: string;

      it('branches correctly via the sandboxed condition evaluator and reaches APPROVED', async () => {
        const fixture = await makeManagerAndReport(tenantAId, branchQaPayrollId, { QATAR_ID: 'QID-3', VISA_SPONSORSHIP: 'Employer' });
        reportEmployeeId = fixture.reportEmployee.id;
        reportToken = fixture.reportToken;

        // Both employees in this DEDICATED branch need real compensation —
        // `PayrollRunProcessor` computes every ACTIVE employee in the
        // branch, and the run can only reach CALCULATED once every one of
        // them has a COMPUTED (not FAILED) line.
        await patch(`/employees/${fixture.managerEmployee.id}`, tokenAdminA, { compensation: { baseSalary: 12000, salaryCurrency: 'QAR' } }).expect(200);
        await patch(`/employees/${reportEmployeeId}`, tokenAdminA, { compensation: { baseSalary: 9000, salaryCurrency: 'QAR' } }).expect(200);

        const draft = await post('/expenses/claims', reportToken, {}).expect(201);
        claimId = draft.body.id;
        await post(`/expenses/claims/${claimId}/lines`, reportToken, {
          categoryId: travelCategoryId,
          description: 'Conference flights',
          amount: 1500,
          expenseDate: '2026-06-01',
        }).expect(201);

        const submitted = await post(`/expenses/claims/${claimId}/submit`, reportToken, {}).expect(201);
        // A genuine multi-currency rollup, Decimal-computed: 1500 QAR *
        // 0.2747 = 412.05 USD, the tenant's base currency.
        expect(submitted.body.totalAmountBaseCurrency).toBe('412.05');

        let detail = await get(`/workflow/instances/${submitted.body.workflowInstanceId}`, fixture.managerToken).expect(200);
        const managerStep = detail.body.steps.find((s: { name: string; status: string }) => s.name === 'Manager approval' && s.status === 'ACTIVE');
        await post(`/workflow/instances/${submitted.body.workflowInstanceId}/steps/${managerStep.id}/actions`, fixture.managerToken, { actionType: 'APPROVE' }).expect(201);

        detail = await get(`/workflow/instances/${submitted.body.workflowInstanceId}`, tokenHrA).expect(200);
        const hrStep = detail.body.steps.find((s: { name: string; status: string }) => s.name === 'HR approval (large amounts only)' && s.status === 'ACTIVE');
        expect(hrStep).toBeDefined();
        await post(`/workflow/instances/${submitted.body.workflowInstanceId}/steps/${hrStep.id}/actions`, tokenHrA, { actionType: 'APPROVE' }).expect(201);

        const approved = await waitFor(async () => {
          const claim = await get(`/expenses/claims/${claimId}`, reportToken).expect(200);
          return claim.body.status === 'APPROVED' ? claim.body : null;
        });
        expect(approved.status).toBe('APPROVED');
      });

      it("a real Payroll run for the claimant's branch merges the APPROVED claim straight onto net pay (never computed by the Expenses module itself) and marks it REIMBURSED", async () => {
        const createRun = await post('/payroll/runs', tokenAdminA, { branchId: branchQaPayrollId, periodYear: 2026, periodMonth: 6 }).expect(201);
        const runId = createRun.body.id;
        await post(`/payroll/runs/${runId}/calculate`, tokenAdminA, {}).expect(201);

        const run = await waitFor(async () => {
          const row = await prisma.payrollRun.findUnique({ where: { id: runId } });
          return row && row.status === 'CALCULATED' ? row : null;
        });
        expect(run.status).toBe('CALCULATED');

        const line = await prisma.payrollRunLine.findFirstOrThrow({ where: { payrollRunId: runId, employeeId: reportEmployeeId } });
        // No income tax in Qatar's pack, no employee-side statutory
        // deduction — net pay is basic salary (9000) PLUS the 1500 QAR
        // reimbursement, added straight on by `PayrollRunProcessor`
        // (never by `PayrollEngineService`/the rules engine).
        expect(Number(line.netPay)).toBeCloseTo(10500, 2);
        const breakdown = line.componentBreakdown as { key: string; amount: number }[];
        const reimbursementLine = breakdown.find((c) => c.key === 'reimbursements');
        expect(reimbursementLine?.amount).toBeCloseTo(1500, 2);

        const claim = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claimId } });
        expect(claim.status).toBe('REIMBURSED');
        expect(claim.reimbursementPayrollRunLineId).toBe(line.id);
        expect(claim.reimbursedAt).not.toBeNull();
      });
    });

    it('a receipt uploaded to a draft line can be downloaded back byte-for-byte', async () => {
      const { reportToken } = await makeManagerAndReport(tenantAId, branchQaId, { QATAR_ID: 'QID-4', VISA_SPONSORSHIP: 'Employer' });
      const draft = await post('/expenses/claims', reportToken, {}).expect(201);
      const line = await post(`/expenses/claims/${draft.body.id}/lines`, reportToken, {
        categoryId: travelCategoryId,
        description: 'Taxi',
        amount: 50,
        expenseDate: '2026-06-01',
      }).expect(201);

      const fileContents = Buffer.from('a totally real receipt');
      await request(app.getHttpServer())
        .post(`/expenses/claims/${draft.body.id}/lines/${line.body.id}/receipt`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${reportToken}`)
        .attach('file', fileContents, 'receipt.txt')
        .expect(201);

      const downloaded = await request(app.getHttpServer())
        .get(`/expenses/claims/${draft.body.id}/lines/${line.body.id}/receipt`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${reportToken}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((downloaded.body as Buffer).toString()).toBe('a totally real receipt');
    });

    it('cross-tenant isolation: tenant B sees none of tenant A\'s expense categories', async () => {
      const res = await get('/expenses/categories', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('Asset Management, and the offboarding clearance checklist\'s real "asset return" step', () => {
    let categoryId: string;
    let assetId: string;
    let assignmentId: string;
    let employeeId: string;
    let processId: string;
    let assetReturnTaskId: string;

    it('an asset is registered and assigned', async () => {
      const fixture = await makeManagerAndReport(tenantAId, branchUsId);
      employeeId = fixture.reportEmployee.id;

      const category = await post('/assets/categories', tokenHrA, { code: 'LAPTOP', name: 'Laptop' }).expect(201);
      categoryId = category.body.id;
      const asset = await post('/assets', tokenHrA, { categoryId, assetTag: `LT-${employeeId.slice(0, 8)}`, name: 'MacBook Pro' }).expect(201);
      assetId = asset.body.id;
      expect(asset.body.status).toBe('AVAILABLE');

      const assignment = await post('/assets/assign', tokenHrA, { assetId, employeeId }).expect(201);
      assignmentId = assignment.body.id;
      expect(assignment.body.status).toBe('ASSIGNED');

      const reloadedAsset = await get(`/assets/${assetId}`, tokenHrA).expect(200);
      expect(reloadedAsset.body.status).toBe('ASSIGNED');

      const mine = await get('/assets/employees/' + employeeId + '/assignments', tokenHrA).expect(200);
      expect(mine.body).toHaveLength(1);
    });

    it('offboarding is initiated and approved; the "asset return" checklist task is BLOCKED while the asset is still assigned', async () => {
      const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
      const manager = await prisma.employee.findUniqueOrThrow({ where: { id: employee.managerId! } });
      const managerToken = jwt.sign({ sub: manager.userId, tenantId: tenantAId });

      const initiate = await post('/offboarding/processes', tokenHrA, { employeeId, reason: 'RESIGNATION', lastWorkingDate: '2026-07-01' }).expect(201);
      processId = initiate.body.id;

      const detail = await get(`/workflow/instances/${initiate.body.workflowInstanceId}`, managerToken).expect(200);
      const activeStep = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${initiate.body.workflowInstanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(201);

      const approved = await waitFor(async () => {
        const process = await get(`/offboarding/processes/${processId}`, tokenHrA).expect(200);
        return process.body.status === 'APPROVED' ? process.body : null;
      });
      assetReturnTaskId = approved.tasks.find((t: { key: string }) => t.key === 'asset_return').id;

      const blocked = await post(`/offboarding/tasks/${assetReturnTaskId}/complete`, tokenHrA, {}).expect(409);
      expect(blocked.body.message).toMatch(/still has assets assigned/i);
    });

    it('returning the asset unblocks the checklist task, which now completes for real', async () => {
      const returned = await post(`/assets/assignments/${assignmentId}/return`, tokenHrA, { returnCondition: 'Good' }).expect(201);
      expect(returned.body.status).toBe('RETURNED');

      const reloadedAsset = await get(`/assets/${assetId}`, tokenHrA).expect(200);
      expect(reloadedAsset.body.status).toBe('AVAILABLE');

      await post(`/offboarding/tasks/${assetReturnTaskId}/complete`, tokenHrA, {}).expect(201);

      const process = await get(`/offboarding/processes/${processId}`, tokenHrA).expect(200);
      const task = process.body.tasks.find((t: { id: string }) => t.id === assetReturnTaskId);
      expect(task.status).toBe('COMPLETED');
    });

    it('cross-tenant isolation: tenant B sees no assets from tenant A', async () => {
      const res = await get('/assets', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('HR Helpdesk / Ticketing', () => {
    let categoryId: string;
    let ticketId: string;
    let raiserToken: string;
    let hrManagerUserId: string;

    it('an employee raises a ticket, comments, and it is assigned and resolved by HR', async () => {
      const fixture = await makeManagerAndReport(tenantAId, branchUsId);
      raiserToken = fixture.reportToken;
      const hrUser = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenantAId, email: 'hr@ops-a.test' } } });
      hrManagerUserId = hrUser.id;

      const category = await post('/helpdesk/categories', tokenHrA, { code: 'IT', name: 'IT Support', defaultSlaMinutes: 60 }).expect(201);
      categoryId = category.body.id;

      const ticket = await post('/helpdesk/tickets', raiserToken, { categoryId, subject: 'Laptop broken', description: 'Screen is cracked', priority: 'HIGH' }).expect(201);
      ticketId = ticket.body.id;
      expect(ticket.body.status).toBe('OPEN');
      expect(ticket.body.slaDueAt).not.toBeNull();

      await post(`/helpdesk/tickets/${ticketId}/comments`, raiserToken, { body: 'Any update?' }).expect(201);

      // The raiser has no standing to assign/resolve — only helpdesk.manage does.
      await post(`/helpdesk/tickets/${ticketId}/assign`, raiserToken, { assignedToUserId: hrManagerUserId }).expect(403);

      const assigned = await post(`/helpdesk/tickets/${ticketId}/assign`, tokenHrA, { assignedToUserId: hrManagerUserId }).expect(201);
      expect(assigned.body.status).toBe('IN_PROGRESS');

      const resolved = await post(`/helpdesk/tickets/${ticketId}/status`, tokenHrA, { status: 'RESOLVED' }).expect(201);
      expect(resolved.body.resolvedAt).not.toBeNull();
    });

    it('an SLA-breached ticket is escalated and notifies HR via the real 0.8 hub', async () => {
      const category = await post('/helpdesk/categories', tokenHrA, { code: 'HR-Q', name: 'HR Query', defaultSlaMinutes: 60 }).expect(201);
      const ticket = await post('/helpdesk/tickets', raiserToken, { categoryId: category.body.id, subject: 'Payslip question', description: 'Where is it?' }).expect(201);

      await prisma.ticket.update({ where: { id: ticket.body.id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });

      const sla = moduleRef.get(TicketSlaService);
      const { escalatedCount } = await sla.sweepOverdueTickets();
      expect(escalatedCount).toBeGreaterThanOrEqual(1);

      const escalated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.body.id } });
      expect(escalated.slaBreached).toBe(true);

      // No assignee yet -> falls back to every ACTIVE HR_MANAGER, the SAME
      // fallback `licensing.issued`/`.revoked` already establish for
      // TENANT_ADMIN — see notification-recipient-resolver.service.ts.
      await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { tenantId: tenantAId, recipientUserId: hrManagerUserId, eventType: 'helpdesk.ticket_escalated' },
        });
        return rows.length >= 1 ? rows : null;
      });
    });

    it('cross-tenant isolation: tenant B sees no tickets from tenant A', async () => {
      const res = await get('/helpdesk/tickets', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('Announcements & Policies', () => {
    it('an announcement targeted at one branch is visible to that branch and not another, and reaches ESS via the seam left in 1.4', async () => {
      const fixtureQa = await makeManagerAndReport(tenantAId, branchQaId);
      const fixtureUs = await makeManagerAndReport(tenantAId, branchUsId);

      const announcement = await post('/announcements', tokenHrA, {
        title: 'Doha office closure',
        body: 'The Doha office will be closed on Friday.',
        targetBranchIds: [branchQaId],
        publish: true,
      }).expect(201);
      expect(announcement.body.publishedAt).not.toBeNull();

      const qaFeed = await get('/announcements', fixtureQa.reportToken).expect(200);
      expect(qaFeed.body.some((a: { id: string }) => a.id === announcement.body.id)).toBe(true);

      const usFeed = await get('/announcements', fixtureUs.reportToken).expect(200);
      expect(usFeed.body.some((a: { id: string }) => a.id === announcement.body.id)).toBe(false);
    });

    it('a policy is published and e-acknowledgment is tracked per user', async () => {
      const fixture1 = await makeManagerAndReport(tenantAId, branchUsId);
      const fixture2 = await makeManagerAndReport(tenantAId, branchUsId);

      const policy = await post('/policies', tokenHrA, { title: 'Code of Conduct', body: 'Be excellent to each other.', publish: true }).expect(201);
      expect(policy.body.publishedAt).not.toBeNull();
      expect(policy.body.version).toBe(1);

      const activeForEss = await get('/policies', fixture1.reportToken).expect(200);
      expect(activeForEss.body.some((p: { id: string }) => p.id === policy.body.id)).toBe(true);

      await post(`/policies/${policy.body.id}/acknowledge`, fixture1.reportToken, {}).expect(201);

      const acks = await get(`/policies/${policy.body.id}/acknowledgments`, tokenHrA).expect(200);
      const ackedUserIds = acks.body.map((a: { userId: string }) => a.userId);
      expect(ackedUserIds).toContain(fixture1.reportUser.id);
      expect(ackedUserIds).not.toContain(fixture2.reportUser.id);

      const mine1 = await get('/policies/my-acknowledgments', fixture1.reportToken).expect(200);
      expect(mine1.body).toHaveLength(1);
      const mine2 = await get('/policies/my-acknowledgments', fixture2.reportToken).expect(200);
      expect(mine2.body).toHaveLength(0);
    });

    it('republishing a policy under the same title creates a NEW version and deactivates the old one', async () => {
      const v1 = await post('/policies', tokenHrA, { title: 'Leave Policy', body: 'v1', publish: true }).expect(201);
      const v2 = await post('/policies', tokenHrA, { title: 'Leave Policy', body: 'v2', publish: true }).expect(201);
      expect(v2.body.version).toBe(v1.body.version + 1);

      const activeList = await get('/policies/admin', tokenHrA).expect(200);
      const v1Row = activeList.body.find((p: { id: string }) => p.id === v1.body.id);
      const v2Row = activeList.body.find((p: { id: string }) => p.id === v2.body.id);
      expect(v1Row.isActive).toBe(false);
      expect(v2Row.isActive).toBe(true);
    });

    it('cross-tenant isolation: tenant B sees no announcements or policies from tenant A', async () => {
      const announcements = await get('/announcements/admin', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(announcements.body).toEqual([]);
      const policies = await get('/policies/admin', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(policies.body).toEqual([]);
    });
  });
});
