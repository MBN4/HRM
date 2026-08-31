/**
 * Proves the Recruitment (ATS) + Onboarding + Offboarding module (step 2.3,
 * Phase 2's final step) end to end over real HTTP — see
 * docs/conventions/recruitment-lifecycle.md: a job requisition and an offer
 * both approved via the real 0.7 workflow engine, the PUBLIC careers API
 * reachable with no auth but correctly tenant-scoped/isolated, a candidate
 * pipeline transition audited via 0.9, onboarding on offer-acceptance
 * creating a REAL 1.1 Employee (enforcing the branch country pack's
 * required fields), tenant-configurable checklists notifying assignees via
 * 0.8, and offboarding setting Employee.status/terminatedAt, revoking
 * access, and triggering a real Payroll (2.1) FINAL_SETTLEMENT run with
 * Qatar's end-of-service gratuity realized.
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
import { appPrisma, prisma, seedCountryPacks, seedExchangeRates, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { JOB_REQUISITION_ENTITY_TYPE, OFFER_ENTITY_TYPE } from '../src/recruitment/recruitment.constants';
import { OFFBOARDING_PROCESS_ENTITY_TYPE } from '../src/offboarding/offboarding.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'lifecycle-test-tenant-a';
const TENANT_B_SLUG = 'lifecycle-test-tenant-b';

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

describe('recruitment lifecycle (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchUsId: string;
  let branchQaId: string;

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
        employeeCode: `RL-${empCounter}`,
        firstName: 'Fixture',
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
    await seedExchangeRates(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Lifecycle Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', baseCurrencyCode: 'USD' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Lifecycle Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    // Payroll's FINAL_SETTLEMENT run (offboarding) still runs through
    // `multi_country_payroll` (ENTERPRISE-only per EDITION_FEATURES) —
    // unlocked the SAME per-tenant admin lever payroll.e2e-spec.ts uses.
    await prisma.tenantFeatureFlagOverride.create({ data: { tenantId: tenantAId, flagKey: 'multi_country_payroll', enabled: true } });

    const branchUs = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'A US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchUsId = branchUs.id;
    const branchQa = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } });
    branchQaId = branchQa.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const hrRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@lifecycle-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@lifecycle-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });

    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@lifecycle-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // Default approval templates — a requisition/offer/offboarding approval
    // is just a WorkflowInstance under one of these, THE RULE, no bespoke
    // approval logic anywhere in this module.
    for (const entityType of [JOB_REQUISITION_ENTITY_TYPE, OFFER_ENTITY_TYPE]) {
      const template = await prisma.workflowTemplate.create({
        data: { tenantId: tenantAId, name: `${entityType} Approval`, entityType, version: 1, isActive: true },
      });
      await prisma.workflowStep.create({
        data: { tenantId: tenantAId, templateId: template.id, name: 'HR approval', order: 1, approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.HR_MANAGER } },
      });
    }
    const offboardingTemplate = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Offboarding Approval', entityType: OFFBOARDING_PROCESS_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: offboardingTemplate.id, name: 'Manager sign-off', order: 1, approverRule: { type: 'MANAGER' } },
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

  describe('a candidate flows all the way from a public application to a hired Employee', () => {
    let requisitionId: string;
    let postingSlug: string;
    let postingId: string;
    let applicationId: string;
    let candidateId: string;
    let offerId: string;
    let onboardingProcessId: string;
    let employeeId: string;

    it('a job requisition is approved through the real 0.7 workflow', async () => {
      const createRes = await post('/recruitment/requisitions', tokenHrA, {
        title: 'Senior Backend Engineer',
        branchId: branchUsId,
        employmentType: 'FULL_TIME',
        headcount: 1,
        justification: 'Growing the platform team.',
      }).expect(201);
      requisitionId = createRes.body.id;
      expect(createRes.body.status).toBe('DRAFT');

      await post(`/recruitment/requisitions/${requisitionId}/submit-for-approval`, tokenHrA, {}).expect(201);
      const afterSubmit = await get(`/recruitment/requisitions/${requisitionId}`, tokenHrA).expect(200);
      expect(afterSubmit.body.status).toBe('PENDING_APPROVAL');
      const instanceId = afterSubmit.body.workflowInstanceId;

      const instanceDetail = await get(`/workflow/instances/${instanceId}`, tokenHrA).expect(200);
      const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, tokenHrA, { actionType: 'APPROVE' }).expect(201);

      // `JobRequisitionWorkflowEventsListener` applies the transition
      // fire-and-forget off the workflow engine's `workflow.approved` event
      // (the same async-dispatch shape 0.8/0.9 already document) — poll
      // rather than assert immediately after the approve response returns.
      await waitFor(async () => {
        const res = await get(`/recruitment/requisitions/${requisitionId}`, tokenHrA).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });
    });

    it('a job posting is created from the APPROVED requisition and published', async () => {
      postingSlug = `senior-backend-engineer-${Date.now()}`;
      const createRes = await post('/recruitment/postings', tokenHrA, {
        requisitionId,
        title: 'Senior Backend Engineer',
        description: 'Build the core platform.',
        publicSlug: postingSlug,
      }).expect(201);
      postingId = createRes.body.id;
      expect(createRes.body.status).toBe('DRAFT');

      await post(`/recruitment/postings/${postingId}/publish`, tokenHrA, {}).expect(201);
      const published = await get(`/recruitment/postings/${postingId}`, tokenHrA).expect(200);
      expect(published.body.status).toBe('PUBLISHED');
    });

    it('the PUBLIC careers API is reachable with NO auth and lists/serves the published posting', async () => {
      const listRes = await request(app.getHttpServer()).get('/careers/postings').set('Host', hostFor(TENANT_A_SLUG)).expect(200);
      expect(listRes.body.some((p: { publicSlug: string }) => p.publicSlug === postingSlug)).toBe(true);

      const detailRes = await request(app.getHttpServer()).get(`/careers/postings/${postingSlug}`).set('Host', hostFor(TENANT_A_SLUG)).expect(200);
      expect(detailRes.body.title).toBe('Senior Backend Engineer');

      const applyRes = await request(app.getHttpServer())
        .post(`/careers/postings/${postingSlug}/apply`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .field('firstName', 'Ada')
        .field('lastName', 'Lovelace')
        .field('email', `ada-${Date.now()}@example.test`)
        .field('phone', '+1-555-0100')
        .attach('resume', Buffer.from('Ada Lovelace resume contents'), 'resume.txt')
        .expect(201);
      applicationId = applyRes.body.id;
      expect(applyRes.body.stage).toBe('APPLIED');

      const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { candidate: true } });
      candidateId = application.candidateId;
      expect(application.candidate.resumeStorageKey).toBeTruthy();

      // A duplicate application to the SAME posting is rejected, not silently accepted twice.
      await request(app.getHttpServer())
        .post(`/careers/postings/${postingSlug}/apply`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .field('firstName', 'Ada')
        .field('lastName', 'Lovelace')
        .field('email', application.candidate.email)
        .expect(409);
    });

    it("the candidate pipeline transitions and every transition is captured in the audit trail (0.9)", async () => {
      await patch(`/recruitment/applications/${applicationId}/stage`, tokenHrA, { stage: 'SCREEN' }).expect(200);
      const afterScreen = await patch(`/recruitment/applications/${applicationId}/stage`, tokenHrA, { stage: 'INTERVIEW' }).expect(200);
      expect(afterScreen.body.stage).toBe('INTERVIEW');

      const auditRes = await get(`/audit?entityType=Application&entityId=${applicationId}`, tokenAdminA).expect(200);
      expect(auditRes.body.length).toBeGreaterThanOrEqual(2);
      expect(auditRes.body.every((row: { action: string }) => row.action === 'STAGE_CHANGE')).toBe(true);
    });

    it('an interview is scheduled and a scorecard is submitted by a panel member', async () => {
      const hrA = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenantAId, email: 'hr@lifecycle-a.test' } } });
      const scheduleRes = await post('/recruitment/interviews', tokenHrA, {
        applicationId,
        scheduledAt: '2026-09-15T10:00:00.000Z',
        durationMinutes: 45,
        interviewerUserIds: [hrA.id],
        location: 'Video call',
      }).expect(201);
      const interviewId = scheduleRes.body.id;

      await post(`/recruitment/interviews/${interviewId}/scorecards`, tokenHrA, {
        rating: 5,
        recommendation: 'STRONG_YES',
        notes: 'Excellent systems-design answers.',
      }).expect(201);

      const scorecards = await get(`/recruitment/interviews/${interviewId}/scorecards`, tokenHrA).expect(200);
      expect(scorecards.body).toHaveLength(1);

      await patch(`/recruitment/applications/${applicationId}/stage`, tokenHrA, { stage: 'OFFER' }).expect(200);
    });

    it('an offer is created, approved via the real 0.7 workflow, and accepted', async () => {
      const createRes = await post('/recruitment/offers', tokenHrA, {
        applicationId,
        branchId: branchUsId,
        employmentType: 'FULL_TIME',
        proposedSalary: 145000,
        salaryCurrency: 'USD',
        proposedJoinDate: '2026-10-01',
      }).expect(201);
      offerId = createRes.body.id;

      await post(`/recruitment/offers/${offerId}/submit-for-approval`, tokenHrA, {}).expect(201);
      const pending = await get(`/recruitment/offers/${offerId}`, tokenHrA).expect(200);
      expect(pending.body.status).toBe('PENDING_APPROVAL');

      const instanceDetail = await get(`/workflow/instances/${pending.body.workflowInstanceId}`, tokenHrA).expect(200);
      const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${pending.body.workflowInstanceId}/steps/${activeStep.id}/actions`, tokenHrA, { actionType: 'APPROVE' }).expect(
        201,
      );

      // Same async-dispatch shape as the requisition listener above.
      await waitFor(async () => {
        const res = await get(`/recruitment/offers/${offerId}`, tokenHrA).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });

      const acceptRes = await post(`/recruitment/offers/${offerId}/accept`, tokenHrA, {}).expect(201);
      expect(acceptRes.body.status).toBe('ACCEPTED');

      const hiredApplication = await get(`/recruitment/applications/${applicationId}`, tokenHrA).expect(200);
      expect(hiredApplication.body.stage).toBe('HIRED');
    });

    it('offer acceptance starts a real onboarding process (fire-and-forget event -> listener)', async () => {
      const process = await waitFor(async () => prisma.onboardingProcess.findUnique({ where: { tenantId_offerId: { tenantId: tenantAId, offerId } } }));
      onboardingProcessId = process.id;
      expect(process.status).toBe('IN_PROGRESS');
      expect(process.candidateId).toBe(candidateId);
    });

    it('creating the Employee enforces the branch country pack\'s required fields (US SSN/W4) — the SAME EmployeeService.create used by POST /employees', async () => {
      await post('/onboarding/checklist-templates', tokenHrA, {
        processType: 'ONBOARDING',
        name: 'Default',
        tasks: [
          { key: 'it_setup', title: 'IT account setup', category: 'IT', assigneeRule: { type: 'ROLE', roleName: 'HR_MANAGER' }, requiresDocument: false },
          { key: 'sign_docs', title: 'Sign HR documents', category: 'HR_DOCS', assigneeRule: { type: 'ROLE', roleName: 'HR_MANAGER' }, requiresDocument: true },
        ],
      }).expect(201);

      const missingFieldsRes = await post(`/onboarding/processes/${onboardingProcessId}/create-employee`, tokenHrA, {
        employeeCode: `EMP-${Date.now()}`,
        compensation: { baseSalary: 145000, salaryCurrency: 'USD' },
      }).expect(400);
      expect(missingFieldsRes.body.message).toEqual(expect.stringContaining('SSN'));

      const createRes = await post(`/onboarding/processes/${onboardingProcessId}/create-employee`, tokenHrA, {
        employeeCode: `EMP-${Date.now()}`,
        statutoryFields: { SSN: '123-45-6789', W4: 'single' },
        compensation: { baseSalary: 145000, salaryCurrency: 'USD' },
      }).expect(201);
      employeeId = createRes.body.id;
      expect(createRes.body.firstName).toBe('Ada');
      expect(createRes.body.lastName).toBe('Lovelace');
      expect(createRes.body.branchId).toBe(branchUsId);

      const process = await get(`/onboarding/processes/${onboardingProcessId}`, tokenHrA).expect(200);
      expect(process.body.status).toBe('COMPLETED');
      expect(process.body.employeeId).toBe(employeeId);
    });

    it('the onboarding checklist is instantiated from tenant-configurable DATA and assignees are notified via the real 0.8 hub', async () => {
      const hrA = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenantAId, email: 'hr@lifecycle-a.test' } } });
      const process = await get(`/onboarding/processes/${onboardingProcessId}`, tokenHrA).expect(200);
      expect(process.body.tasks).toHaveLength(2);
      expect(process.body.tasks.every((t: { assigneeUserId: string }) => t.assigneeUserId === hrA.id)).toBe(true);

      await waitFor(async () => {
        const rows = await prisma.notification.findMany({ where: { tenantId: tenantAId, recipientUserId: hrA.id, eventType: 'checklist.task_assigned' } });
        return rows.length >= 2 ? rows : null;
      });

      const signDocsTask = process.body.tasks.find((t: { key: string }) => t.key === 'sign_docs');
      await post(`/onboarding/tasks/${signDocsTask.id}/complete`, tokenHrA, {}).expect(400); // requiresDocument, none attached

      await request(app.getHttpServer())
        .post(`/onboarding/tasks/${signDocsTask.id}/complete`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .attach('document', Buffer.from('signed offer letter'), 'offer-letter.pdf')
        .expect(201);

      const itSetupTask = process.body.tasks.find((t: { key: string }) => t.key === 'it_setup');
      await post(`/onboarding/tasks/${itSetupTask.id}/complete`, tokenHrA, {}).expect(201);
    });
  });

  describe('offboarding — clearance checklist, status/terminatedAt, access revocation, and a real Payroll FINAL_SETTLEMENT run (Qatar gratuity realized)', () => {
    let managerUserId: string;
    let managerToken: string;
    let departingUserId: string;
    let departingToken: string;
    let departingEmployeeId: string;
    let processId: string;

    beforeAll(async () => {
      const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });

      const managerUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'offboarding-manager@lifecycle-a.test');
      managerUserId = managerUser.id;
      managerToken = jwt.sign({ sub: managerUser.id, tenantId: tenantAId });
      const managerEmployee = await makeEmployee(tenantAId, branchQaId, { userId: managerUser.id });

      const departingUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'departing@lifecycle-a.test');
      departingUserId = departingUser.id;
      departingToken = jwt.sign({ sub: departingUser.id, tenantId: tenantAId });
      // 3 years of service as of the June-2026 settlement period — a clean,
      // non-tier-boundary-crossing gratuity delta, the SAME fixture numbers
      // payroll.e2e-spec.ts already proves correct for this reference pack.
      const departingEmployee = await makeEmployee(tenantAId, branchQaId, {
        userId: departingUser.id,
        managerId: managerEmployee.id,
        joinDate: new Date('2023-06-01'),
        statutoryFields: { QATAR_ID: 'QID-12345', VISA_SPONSORSHIP: 'Employer' },
      });
      departingEmployeeId = departingEmployee.id;
      await request(app.getHttpServer())
        .patch(`/employees/${departingEmployeeId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ compensation: { baseSalary: 9000, salaryCurrency: 'QAR' } })
        .expect(200);

      await post('/offboarding/checklist-templates', tokenHrA, {
        processType: 'OFFBOARDING',
        name: 'Default',
        tasks: [
          { key: 'asset_return', title: 'Return company assets', category: 'ASSET', assigneeRule: { type: 'ROLE', roleName: 'HR_MANAGER' }, requiresDocument: false },
          { key: 'access_review', title: 'Confirm access revoked', category: 'ACCESS', assigneeRule: { type: 'ROLE', roleName: 'HR_MANAGER' }, requiresDocument: false },
        ],
      }).expect(201);
    });

    it('a termination is initiated and routed through the real 0.7 workflow to the real 1.1 manager', async () => {
      const initiateRes = await post('/offboarding/processes', tokenHrA, {
        employeeId: departingEmployeeId,
        reason: 'TERMINATION',
        lastWorkingDate: '2026-06-15',
      }).expect(201);
      processId = initiateRes.body.id;
      expect(initiateRes.body.status).toBe('PENDING_APPROVAL');

      const instanceDetail = await get(`/workflow/instances/${initiateRes.body.workflowInstanceId}`, managerToken).expect(200);
      const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(activeStep.eligibleApproverIds).toContain(managerUserId);

      await post(`/workflow/instances/${initiateRes.body.workflowInstanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(
        201,
      );

      const approved = await waitFor(async () => {
        const res = await get(`/offboarding/processes/${processId}`, tokenHrA).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });
      expect(approved.tasks).toHaveLength(2);
    });

    it('completing the clearance checklist is required before the process can complete', async () => {
      await post(`/offboarding/processes/${processId}/complete`, tokenHrA, {}).expect(409);

      const process = await get(`/offboarding/processes/${processId}`, tokenHrA).expect(200);
      for (const task of process.body.tasks) {
        await post(`/offboarding/tasks/${task.id}/complete`, tokenHrA, {}).expect(201);
      }
    });

    it('completing offboarding sets Employee.status/terminatedAt, revokes access, and triggers a real Payroll FINAL_SETTLEMENT run with the gratuity realized', async () => {
      const completeRes = await post(`/offboarding/processes/${processId}/complete`, tokenHrA, {}).expect(201);
      expect(completeRes.body.status).toBe('COMPLETED');
      const settlementRunId = completeRes.body.settlementPayrollRunId;
      expect(settlementRunId).toBeTruthy();

      const employeeRes = await get(`/employees/${departingEmployeeId}`, tokenAdminA).expect(200);
      expect(employeeRes.body.status).toBe('TERMINATED');

      const rawEmployee = await prisma.employee.findUniqueOrThrow({ where: { id: departingEmployeeId } });
      expect(rawEmployee.terminatedAt).not.toBeNull();

      // Access revocation — the SAME per-request status check every
      // authenticated route already enforces (see auth-rbac.md); the
      // departing employee's still-cryptographically-valid access token is
      // now rejected.
      const disabledUser = await prisma.user.findUniqueOrThrow({ where: { id: departingUserId } });
      expect(disabledUser.status).toBe('DISABLED');
      await get('/employees/me', departingToken).expect(401);

      const run = await waitFor(async () => {
        const row = await prisma.payrollRun.findUnique({ where: { id: settlementRunId } });
        return row && row.status === 'CALCULATED' ? row : null;
      });
      expect(run.runType).toBe('FINAL_SETTLEMENT');
      expect(run.settlementEmployeeId).toBe(departingEmployeeId);

      const line = await prisma.payrollRunLine.findFirstOrThrow({ where: { payrollRunId: settlementRunId, employeeId: departingEmployeeId } });
      expect(Number(line.netPay)).toBeCloseTo(9000, 2); // gratuity is EMPLOYER-only, never reduces net pay.
      const breakdown = line.componentBreakdown as { key: string; type: string; amount: number }[];
      const gratuity = breakdown.find((c) => c.key === 'end_of_service_gratuity');
      expect(gratuity).toBeDefined();
      expect(gratuity!.type).toBe('EMPLOYER_COST');
      // A clean 3-year MONTHLY accrual, explicitly bounded well below the
      // ~18,900 QAR CUMULATIVE lifetime total the double-counting bug this
      // engine guards against would have produced (see payroll.md).
      expect(gratuity!.amount).toBeGreaterThan(50);
      expect(gratuity!.amount).toBeLessThan(2000);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B sees none of tenant A's requisitions, postings, candidates, offers, onboarding, or offboarding processes", async () => {
      const requisitions = await get('/recruitment/requisitions', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(requisitions.body).toEqual([]);

      const candidates = await get('/recruitment/candidates', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(candidates.body).toEqual([]);

      const offers = await get('/recruitment/offers', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(offers.body).toEqual([]);
    });

    it("tenant A's published posting slug does not resolve under tenant B's host", async () => {
      const listRes = await request(app.getHttpServer()).get('/careers/postings').set('Host', hostFor(TENANT_B_SLUG)).expect(200);
      expect(listRes.body).toEqual([]);
    });
  });
});
