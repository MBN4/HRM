/**
 * Phase 6.2 — the ONE consolidated, exhaustive cross-tenant isolation
 * regression suite. Every individual module's own e2e suite already
 * asserts isolation informally within its own scope; this file's job is
 * different: walk EVERY entity/module built from step 0.x through 6.1 in
 * ONE place and prove the hard boundary (Row-Level Security — see
 * docs/conventions/tenancy-rls.md) actually holds for each of them, using
 * two REAL tenants with REAL seeded data, never a mocked service.
 *
 * Two tenants, both TENANT_ADMIN (which — per seed-rbac.ts — holds EVERY
 * permission), so a 403/404/empty-list below is never RBAC's doing: it can
 * only be tenant isolation. Both tenants are given an ENTERPRISE
 * subscription so no feature-flag gate (payroll's MULTI_COUNTRY_PAYROLL,
 * webhooks/API keys' PROFESSIONAL+ gate, ...) produces a false-negative
 * 403 that would be mistaken for an isolation proof.
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
import { PERMISSIONS } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'iso-exhaustive-tenant-a';
const TENANT_B_SLUG = 'iso-exhaustive-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

/** A thin bound-token/host HTTP client, mirroring integrations-api-keys.e2e-spec.ts's own `jwt.sign({sub,tenantId})` shortcut — an ordinary login isn't needed to prove RLS/RBAC-adjacent isolation. */
function client(app: INestApplication, token: string, tenantSlug: string) {
  const host = hostFor(tenantSlug);
  return {
    get: (path: string) => request(app.getHttpServer()).get(path).set('Host', host).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: unknown) =>
      request(app.getHttpServer()).post(path).set('Host', host).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (path: string, body?: unknown) =>
      request(app.getHttpServer()).put(path).set('Host', host).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (path: string, body?: unknown) =>
      request(app.getHttpServer()).patch(path).set('Host', host).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    delete: (path: string) => request(app.getHttpServer()).delete(path).set('Host', host).set('Authorization', `Bearer ${token}`),
  };
}

/** GET-by-id / mutation cross-tenant status is 403 in some routes (an explicit branch/permission check) and 404 in others (RLS makes the row simply not exist to that tenant's transaction) — both are correct; a caller should never be able to tell which from the outside. */
const CROSS_TENANT_STATUSES = [403, 404];

describe('cross-tenant isolation — exhaustive regression (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let adminAUserId: string;
  let tokenA: string;
  let tokenB: string;
  let asA: ReturnType<typeof client>;
  let asB: ReturnType<typeof client>;

  let branchAId: string;
  let branchBId: string;
  let deptAId: string;

  let employeeAId: string;
  let employeeBId: string;
  let leaveBalanceA: { id: string; accruedDays: number };
  let leaveRequestAId: string;
  let attendanceRecordAId: string;
  let payrollRunAId: string;
  let goalAId: string;
  let cycleAId: string;
  let requisitionAId: string;
  let postingASlug: string;
  let postingAId: string;
  let candidateAId: string;
  let applicationAId: string;
  let offerAId: string;
  let onboardingProcessAId: string;
  let offboardingProcessAId: string;
  let expenseClaimAId: string;
  let assetAId: string;
  let ticketAId: string;
  let announcementAId: string;
  let policyAId: string;
  let courseAId: string;
  let enrollmentAId: string;
  let webhookSubAId: string;
  let apiKeyAId: string;
  let apiKeyARawKey: string;
  let importBatchAId: string;
  let benefitPlanAId: string;
  let benefitEnrollmentAId: string;
  let signatureRequestAId: string;
  let generatedReportAId: string;
  let dataSubjectRequestAId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Iso Exhaustive Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Iso Exhaustive Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    // ENTERPRISE on BOTH tenants — this suite is about isolation, not
    // licensing, so no route's own feature-flag gate (payroll's
    // MULTI_COUNTRY_PAYROLL, webhooks/API keys' PROFESSIONAL+ WEBHOOKS/
    // API_ACCESS) should ever produce a 403 that could be mistaken for an
    // isolation proof.
    await prisma.subscription.create({ data: { tenantId: tenantAId, edition: 'ENTERPRISE', status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { tenantId: tenantBId, edition: 'ENTERPRISE', status: 'ACTIVE' } });

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@iso-exhaustive-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    adminAUserId = adminA.id;
    tokenA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@iso-exhaustive-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
    tokenB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    asA = client(app, tokenA, TENANT_A_SLUG);
    asB = client(app, tokenB, TENANT_B_SLUG);

    // --- Tenancy: branches / departments / cost centers -------------------
    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Iso A HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchAId = branchA.id;
    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'Iso B HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchBId = branchB.id;
    const deptA = await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchAId, name: 'Iso A Engineering' } });
    deptAId = deptA.id;
    await prisma.costCenter.create({ data: { tenantId: tenantAId, code: 'ISO-A-CC1', name: 'Iso A Cost Center' } });

    // --- Employees (incl. encrypted salary/bank details) — via the REAL
    // HTTP create path so field-level gating + encryption both run for real.
    const employeeCreate = await asA
      .post('/employees', {
        employeeCode: 'ISO-A-1',
        firstName: 'Alice',
        lastName: 'IsoTenantA',
        branchId: branchAId,
        departmentId: deptAId,
        employmentType: 'FULL_TIME',
        joinDate: '2024-01-15',
        statutoryFields: { SSN: '123-45-6789', W4: 'on-file' },
        bankDetails: { accountNumber: '00011122233', bankName: 'Iso Test Bank', routingCode: '021000021' },
        compensation: { baseSalary: 145000, salaryCurrency: 'USD' },
      })
      .expect(201);
    employeeAId = employeeCreate.body.id;
    expect(employeeCreate.body.compensation.baseSalary).toBe(145000);

    const employeeB = await prisma.employee.create({
      data: {
        tenantId: tenantBId,
        employeeCode: 'ISO-B-1',
        firstName: 'Bob',
        lastName: 'IsoTenantB',
        branchId: branchBId,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2024-02-01'),
      },
    });
    employeeBId = employeeB.id;

    // --- Leave: requests + balances ----------------------------------------
    leaveBalanceA = await prisma.leaveBalance.create({
      data: { tenantId: tenantAId, employeeId: employeeAId, leaveType: 'ANNUAL', periodYear: 2026, entitledDays: 20, accruedDays: 12 },
    });
    const leaveRequestA = await prisma.leaveRequest.create({
      data: {
        tenantId: tenantAId,
        employeeId: employeeAId,
        leaveType: 'ANNUAL',
        startDate: new Date('2026-07-06'),
        endDate: new Date('2026-07-08'),
        days: 3,
        reason: 'iso-exhaustive fixture',
      },
    });
    leaveRequestAId = leaveRequestA.id;

    // --- Attendance: records -------------------------------------------------
    const attendanceRecordA = await prisma.attendanceRecord.create({
      data: {
        tenantId: tenantAId,
        employeeId: employeeAId,
        branchId: branchAId,
        workDate: new Date('2026-06-01'),
        clockInAt: new Date('2026-06-01T09:00:00Z'),
        clockInSource: 'WEB',
      },
    });
    attendanceRecordAId = attendanceRecordA.id;

    // --- Payroll: runs (light — a real create is a heavy pack-driven
    // multi-step flow already proven end to end in payroll.e2e-spec.ts;
    // here we only need a real row to prove the LIST/GET routes never leak).
    const payrollRunA = await prisma.payrollRun.create({
      data: { tenantId: tenantAId, branchId: branchAId, periodYear: 2026, periodMonth: 6, payrollMode: 'CALCULATE', currencyCode: 'USD' },
    });
    payrollRunAId = payrollRunA.id;

    // --- Performance: goals / cycles ----------------------------------------
    const ratingScaleA = await prisma.ratingScale.create({
      data: {
        tenantId: tenantAId,
        key: 'ISO_5PT',
        name: 'Iso 5-point',
        levels: [
          { value: 1, label: 'Poor' },
          { value: 5, label: 'Excellent' },
        ],
      },
    });
    const cycleA = await prisma.appraisalCycle.create({
      data: {
        tenantId: tenantAId,
        name: 'Iso A Cycle 2026',
        cycleType: 'ANNUAL',
        ratingScaleId: ratingScaleA.id,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        enabledReviewTypes: ['SELF'],
      },
    });
    cycleAId = cycleA.id;
    const goalA = await prisma.goal.create({
      data: {
        tenantId: tenantAId,
        level: 'INDIVIDUAL',
        employeeId: employeeAId,
        cycleId: cycleAId,
        title: 'Iso A confidential goal',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-06-30'),
      },
    });
    goalAId = goalA.id;

    // --- Recruitment: requisitions / postings / candidates / applications /
    // offers — also feeds Onboarding below. `postingA` is PUBLISHED so the
    // PUBLIC careers API has something real to (not) leak across tenants.
    const requisitionA = await prisma.jobRequisition.create({
      data: {
        tenantId: tenantAId,
        title: 'Iso A Confidential Requisition',
        branchId: branchAId,
        employmentType: 'FULL_TIME',
        createdByUserId: adminAUserId,
      },
    });
    requisitionAId = requisitionA.id;
    postingASlug = 'iso-a-confidential-posting';
    const postingA = await prisma.jobPosting.create({
      data: {
        tenantId: tenantAId,
        requisitionId: requisitionAId,
        title: 'Iso A Confidential Posting',
        description: 'Should never be visible from tenant B.',
        publicSlug: postingASlug,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    postingAId = postingA.id;
    const candidateA = await prisma.candidate.create({
      data: { tenantId: tenantAId, firstName: 'Cara', lastName: 'Candidate', email: 'cara@iso-exhaustive-a.test' },
    });
    candidateAId = candidateA.id;
    const applicationA = await prisma.application.create({
      data: { tenantId: tenantAId, candidateId: candidateAId, jobPostingId: postingAId },
    });
    applicationAId = applicationA.id;
    const offerA = await prisma.offer.create({
      data: {
        tenantId: tenantAId,
        applicationId: applicationAId,
        branchId: branchAId,
        employmentType: 'FULL_TIME',
        proposedSalary: 150000,
        salaryCurrency: 'USD',
        proposedJoinDate: new Date('2026-08-01'),
        createdByUserId: adminAUserId,
      },
    });
    offerAId = offerA.id;

    // --- Onboarding / Offboarding — lighter treatment: the requisition ->
    // posting -> candidate -> application -> offer chain above is created
    // directly rather than through the full multi-step ATS workflow (that
    // real flow, incl. workflow-engine approval, is already proven in
    // recruitment-lifecycle.e2e-spec.ts); here we only need a real
    // OnboardingProcess/OffboardingProcess row to prove list/get isolation.
    const onboardingA = await prisma.onboardingProcess.create({
      data: { tenantId: tenantAId, offerId: offerAId, candidateId: candidateAId, status: 'IN_PROGRESS' },
    });
    onboardingProcessAId = onboardingA.id;
    const offboardingA = await prisma.offboardingProcess.create({
      data: {
        tenantId: tenantAId,
        employeeId: employeeAId,
        reason: 'RESIGNATION',
        lastWorkingDate: new Date('2026-09-30'),
        initiatedByUserId: adminAUserId,
      },
    });
    offboardingProcessAId = offboardingA.id;

    // --- Operations modules: expenses / assets / helpdesk / announcements --
    const expenseCategoryA = await prisma.expenseCategory.create({ data: { tenantId: tenantAId, code: 'TRAVEL', name: 'Travel' } });
    // POST /expenses/claims only creates the DRAFT shell (employeeId
    // explicit since the caller — adminA — has no Employee row of its
    // own); line items are added via a SEPARATE call.
    const expenseClaimRes = await asA.post('/expenses/claims', { employeeId: employeeAId }).expect(201);
    expenseClaimAId = expenseClaimRes.body.id;
    await asA
      .post(`/expenses/claims/${expenseClaimAId}/lines`, {
        categoryId: expenseCategoryA.id,
        description: 'Iso A confidential expense',
        amount: 42.5,
        expenseDate: '2026-06-05',
      })
      .expect(201);

    const assetCategoryA = await prisma.assetCategory.create({ data: { tenantId: tenantAId, code: 'LAPTOP', name: 'Laptop' } });
    const assetRes = await asA
      .post('/assets', { categoryId: assetCategoryA.id, assetTag: 'ISO-A-ASSET-1', name: 'Iso A MacBook' })
      .expect(201);
    assetAId = assetRes.body.id;

    const ticketCategoryA = await prisma.ticketCategory.create({ data: { tenantId: tenantAId, code: 'IT', name: 'IT Support' } });
    const ticketRes = await asA
      .post('/helpdesk/tickets', { categoryId: ticketCategoryA.id, subject: 'Iso A confidential ticket', description: 'Should never leak.' })
      .expect(201);
    ticketAId = ticketRes.body.id;

    const announcementRes = await asA.post('/announcements', { title: 'Iso A Announcement', body: 'Confidential.' }).expect(201);
    announcementAId = announcementRes.body.id;
    const policyRes = await asA.post('/policies', { title: 'Iso A Policy', body: 'Confidential policy body.' }).expect(201);
    policyAId = policyRes.body.id;

    // --- LMS: courses / enrollments ------------------------------------------
    const courseRes = await asA.post('/lms/courses', { title: 'Iso A Confidential Course' }).expect(201);
    courseAId = courseRes.body.id;
    const enrollmentA = await prisma.enrollment.create({ data: { tenantId: tenantAId, courseId: courseAId, employeeId: employeeAId, branchId: branchAId } });
    enrollmentAId = enrollmentA.id;

    // --- Integrations: webhook subscriptions / API keys (incl. the SEPARATE
    // /v1 X-Api-Key auth path) --------------------------------------------
    const webhookRes = await asA
      .post('/integrations/webhooks/subscriptions', { url: 'https://example.com/iso-a-hook', eventTypes: ['auth.login'] })
      .expect(201);
    webhookSubAId = webhookRes.body.id;
    const apiKeyRes = await asA.post('/integrations/api-keys', { name: 'iso-a-key', scopes: [PERMISSIONS.EMPLOYEE_READ] }).expect(201);
    apiKeyAId = apiKeyRes.body.id;
    apiKeyARawKey = apiKeyRes.body.rawKey;

    // --- Branding ------------------------------------------------------------
    await asA.put('/branding', { productName: 'Iso A Confidential Brand' }).expect(200);

    // --- Migration: import batches (light — seeded directly; the real
    // multi-phase VALIDATE/COMMIT flow is proven in migration.e2e-spec.ts) --
    const importBatchA = await prisma.importBatch.create({
      data: { tenantId: tenantAId, entityType: 'EMPLOYEE', fileName: 'iso-a.csv', fileFormat: 'CSV', columnMapping: {} },
    });
    importBatchAId = importBatchA.id;

    // --- Benefits: plans / enrollments ---------------------------------------
    const benefitPlanRes = await asA
      .post('/benefits/plans', {
        code: 'ISO-A-HEALTH',
        name: 'Iso A Health Plan',
        benefitType: 'HEALTH_INSURANCE',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 100,
        employeeSharePercent: 0.5,
        employerSharePercent: 0.5,
      })
      .expect(201);
    benefitPlanAId = benefitPlanRes.body.id;
    const benefitEnrollmentRes = await asA
      .post('/benefits/enrollments', { employeeId: employeeAId, planId: benefitPlanAId, effectiveFrom: '2026-01-01' })
      .expect(201);
    benefitEnrollmentAId = benefitEnrollmentRes.body.id;

    // --- E-signature (light — seeded directly; the full sequential/
    // parallel signing + evidentiary trail is proven in esignature.e2e-spec.ts) --
    const signatureRequestA = await prisma.signatureRequest.create({
      data: {
        tenantId: tenantAId,
        title: 'Iso A Confidential Signature Request',
        documentSource: 'UPLOADED',
        documentStorageKey: 'iso-exhaustive/tenant-a/doc.pdf',
        documentHash: 'a'.repeat(64),
        createdByUserId: adminAUserId,
      },
    });
    signatureRequestAId = signatureRequestA.id;

    // --- Statutory reporting (light — reuses the globally-seeded catalog
    // row; the real generation pipeline is proven in
    // statutory-reporting.e2e-spec.ts) ---------------------------------------
    const reportDefinition = await prisma.statutoryReportDefinition.findFirstOrThrow();
    const generatedReportA = await prisma.generatedReport.create({
      data: {
        tenantId: tenantAId,
        branchId: branchAId,
        reportDefinitionId: reportDefinition.id,
        reportCode: reportDefinition.reportCode,
        countryCode: reportDefinition.countryCode,
        periodType: 'MONTHLY',
        periodYear: 2026,
        periodMonth: 6,
        periodKey: '2026-06',
      },
    });
    generatedReportAId = generatedReportA.id;

    // --- Privacy: data subject requests (light — seeded directly; the
    // real export/erasure engine is proven in privacy-residency.e2e-spec.ts) --
    const dataSubjectRequestA = await prisma.dataSubjectRequest.create({
      data: { tenantId: tenantAId, requestType: 'EXPORT', subjectType: 'EMPLOYEE', subjectId: employeeAId, requestedByUserId: adminAUserId },
    });
    dataSubjectRequestAId = dataSubjectRequestA.id;

    // --- Custom fields: definitions -------------------------------------------
    await asA
      .post('/custom-fields/definitions', { entityType: 'Employee', fieldKey: 'iso_isolation_test', label: 'Iso Isolation Test', fieldType: 'STRING' })
      .expect(201);

    // --- Analytics: precomputed rollups (light — a real headcount snapshot
    // row so the dashboard read has real tenant-A data to (not) leak; the
    // real scheduled rollup job itself is proven in analytics.e2e-spec.ts) --
    await prisma.headcountDailySnapshot.create({
      data: { tenantId: tenantAId, snapshotDate: new Date('2026-06-15'), branchId: branchAId, employmentType: 'FULL_TIME', activeCount: 777 },
    });
  }, 60000);

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  // ==========================================================================
  // Generic cross-tenant attack shapes
  // ==========================================================================

  describe('token replay across tenants', () => {
    it('a tenant-A JWT replayed against a request resolved to tenant B is rejected', async () => {
      await request(app.getHttpServer())
        .get('/employees')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
    });

    it('a tenant-B JWT replayed against a request resolved to tenant A is rejected', async () => {
      await request(app.getHttpServer())
        .get('/employees')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(401);
    });
  });

  describe('tenancy — branches (departments/cost centers have no dedicated HTTP surface; see note below)', () => {
    it('tenant B never sees tenant A branches via the list route', async () => {
      const res = await asB.get('/tenancy/branches').expect(200);
      expect(res.body.some((b: { id: string }) => b.id === branchAId)).toBe(false);
      expect(res.body.every((b: { id: string }) => b.id !== branchAId)).toBe(true);
    });

    it('a crafted ?tenantId query param cannot override the real resolved tenant (RLS/cache boundary both hold)', async () => {
      const res = await asA.get(`/tenancy/branches?tenantId=${tenantBId}`).expect(200);
      expect(res.body).toEqual([]);
    });

    // Department/CostCenter/Designation have NO dedicated list/get HTTP
    // route in this codebase (they're referenced by id only, from
    // Employee/JobRequisition/etc. create calls) — their isolation is
    // covered at the DB layer generically by
    // packages/db/test/tenant-isolation.spec.ts, and indirectly here by
    // the fact that no Employee/JobRequisition response below ever surfaces
    // a cross-tenant department/cost-center id.
  });

  describe('employees — incl. encrypted salary/bank-detail fields', () => {
    it('list: tenant B never sees tenant A employees, even by name/employeeCode match', async () => {
      const res = await asB.get('/employees').expect(200);
      expect(res.body.data.some((e: { id: string }) => e.id === employeeAId)).toBe(false);
      expect(res.body.data.some((e: { employeeCode: string }) => e.employeeCode === 'ISO-A-1')).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A employee by id — and the encrypted salary/bank fields never leak, even in the response body', async () => {
      const res = await asB.get(`/employees/${employeeAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toContain('145000');
      expect(bodyText).not.toContain('00011122233');
      expect(bodyText).not.toContain('ISO-A-1');
    });

    it('mutation-non-landing: tenant B cannot update tenant A employee, and the row is provably unchanged', async () => {
      const res = await asB.patch(`/employees/${employeeAId}`, { firstName: 'Hacked' });
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.employee.findUniqueOrThrow({ where: { id: employeeAId } });
      expect(stillReal.firstName).toBe('Alice');
    });

    it('tenant B has its own, real, DIFFERENT employee data (not just an empty tenant)', async () => {
      const res = await asB.get('/employees').expect(200);
      expect(res.body.data.some((e: { id: string }) => e.id === employeeBId)).toBe(true);
    });
  });

  describe('leave — requests + balances', () => {
    it('list: tenant B never sees tenant A leave requests', async () => {
      const res = await asB.get('/leave/requests').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((r: { id: string }) => r.id === leaveRequestAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A leave request by id', async () => {
      const res = await asB.get(`/leave/requests/${leaveRequestAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it("get-by-employeeId: tenant B addressing tenant A's employee for leave balances resolves nothing (the employeeId itself is out of tenant B's RLS-scoped reach)", async () => {
      const res = await asB.get(`/leave/balances?employeeId=${employeeAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it("get-by-employeeId: tenant B addressing its OWN employee's leave balances never returns tenant A's balance row", async () => {
      const res = await asB.get(`/leave/balances?employeeId=${employeeBId}`).expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((b: { id: string }) => b.id === leaveBalanceA.id)).toBe(false);
    });

    it('mutation-non-landing: tenant B cannot adjust tenant A leave balance, and it is provably unchanged', async () => {
      const res = await asB.post(`/leave/balances/${employeeAId}/adjust`, { leaveType: 'ANNUAL', deltaDays: 999 });
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.leaveBalance.findUniqueOrThrow({ where: { id: leaveBalanceA.id } });
      expect(stillReal.accruedDays).toBe(leaveBalanceA.accruedDays);
    });
  });

  describe('attendance — records', () => {
    it('list: tenant B never sees tenant A attendance records', async () => {
      const res = await asB.get('/attendance/records').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((r: { id: string }) => r.id === attendanceRecordAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A attendance record by id', async () => {
      const res = await asB.get(`/attendance/records/${attendanceRecordAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('payroll — runs (lighter: list/get only — a real pack-driven run is already proven end to end in payroll.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A payroll runs', async () => {
      const res = await asB.get('/payroll/runs').expect(200);
      expect(res.body.some((r: { id: string }) => r.id === payrollRunAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A payroll run by id', async () => {
      const res = await asB.get(`/payroll/runs/${payrollRunAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('performance — goals + cycles', () => {
    it('list: tenant B never sees tenant A goals', async () => {
      const res = await asB.get('/performance/goals').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((g: { id: string }) => g.id === goalAId)).toBe(false);
    });

    it('list: tenant B never sees tenant A appraisal cycles', async () => {
      const res = await asB.get('/performance/cycles').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((c: { id: string }) => c.id === cycleAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A cycle by id', async () => {
      const res = await asB.get(`/performance/cycles/${cycleAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it('mutation-non-landing: tenant B cannot update tenant A goal progress, and it is provably unchanged', async () => {
      const res = await asB.patch(`/performance/goals/${goalAId}/progress`, { progressPercent: 99 });
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.goal.findUniqueOrThrow({ where: { id: goalAId } });
      expect(stillReal.progressPercent).toBe(0);
    });
  });

  describe('recruitment — requisitions/postings/candidates/applications + the public careers API', () => {
    it('list: tenant B never sees tenant A requisitions', async () => {
      const res = await asB.get('/recruitment/requisitions').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((r: { id: string }) => r.id === requisitionAId)).toBe(false);
    });

    it('list: tenant B never sees tenant A postings or candidates', async () => {
      const postings = await asB.get('/recruitment/postings').expect(200);
      const postingRows = Array.isArray(postings.body) ? postings.body : postings.body.data;
      expect(postingRows.some((p: { id: string }) => p.id === postingAId)).toBe(false);

      const candidates = await asB.get('/recruitment/candidates').expect(200);
      const candidateRows = Array.isArray(candidates.body) ? candidates.body : candidates.body.data;
      expect(candidateRows.some((c: { id: string }) => c.id === candidateAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A requisition/candidate by id', async () => {
      const req = await asB.get(`/recruitment/requisitions/${requisitionAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(req.status);
      const cand = await asB.get(`/recruitment/candidates/${candidateAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(cand.status);
    });

    it("the PUBLIC careers API is public but still TENANT-scoped: a published posting is visible under tenant A's Host, never under tenant B's", async () => {
      const underA = await request(app.getHttpServer()).get('/careers/postings').set('Host', hostFor(TENANT_A_SLUG)).expect(200);
      expect(underA.body.some((p: { publicSlug: string }) => p.publicSlug === postingASlug)).toBe(true);

      const underB = await request(app.getHttpServer()).get('/careers/postings').set('Host', hostFor(TENANT_B_SLUG)).expect(200);
      expect(underB.body.some((p: { publicSlug: string }) => p.publicSlug === postingASlug)).toBe(false);

      // Even addressing tenant A's own slug directly, under tenant B's Host,
      // must 404 — the slug alone is not enough to cross the tenant boundary.
      await request(app.getHttpServer()).get(`/careers/postings/${postingASlug}`).set('Host', hostFor(TENANT_B_SLUG)).expect(404);
    });
  });

  describe('onboarding / offboarding — processes (lighter: the requisition->offer chain above is seeded directly, not via the full ATS approval flow already proven in recruitment-lifecycle.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A onboarding processes', async () => {
      const res = await asB.get('/onboarding/processes').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((p: { id: string }) => p.id === onboardingProcessAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A onboarding process by id', async () => {
      const res = await asB.get(`/onboarding/processes/${onboardingProcessAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it('list: tenant B never sees tenant A offboarding processes', async () => {
      const res = await asB.get('/offboarding/processes').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((p: { id: string }) => p.id === offboardingProcessAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A offboarding process by id', async () => {
      const res = await asB.get(`/offboarding/processes/${offboardingProcessAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('operations modules — expenses / assets / helpdesk / announcements', () => {
    it('list: tenant B never sees tenant A expense claims', async () => {
      const res = await asB.get('/expenses/claims').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((c: { id: string }) => c.id === expenseClaimAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A expense claim by id', async () => {
      const res = await asB.get(`/expenses/claims/${expenseClaimAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it('list + get-by-id: tenant B never sees tenant A assets', async () => {
      const list = await asB.get('/assets').expect(200);
      const rows = Array.isArray(list.body) ? list.body : list.body.data;
      expect(rows.some((a: { id: string }) => a.id === assetAId)).toBe(false);

      const byId = await asB.get(`/assets/${assetAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(byId.status);
    });

    it('list + get-by-id: tenant B never sees tenant A helpdesk tickets', async () => {
      const list = await asB.get('/helpdesk/tickets').expect(200);
      const rows = Array.isArray(list.body) ? list.body : list.body.data;
      expect(rows.some((t: { id: string }) => t.id === ticketAId)).toBe(false);

      const byId = await asB.get(`/helpdesk/tickets/${ticketAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(byId.status);
    });

    it('mutation-non-landing: tenant B cannot change tenant A ticket status, and it is provably unchanged', async () => {
      const res = await asB.post(`/helpdesk/tickets/${ticketAId}/status`, { status: 'CLOSED' });
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketAId } });
      expect(stillReal.status).toBe('OPEN');
    });

    it('list: tenant B never sees tenant A announcements or policies', async () => {
      const announcements = await asB.get('/announcements').expect(200);
      const announcementRows = Array.isArray(announcements.body) ? announcements.body : announcements.body.data;
      expect(announcementRows.some((a: { id: string }) => a.id === announcementAId)).toBe(false);

      const policies = await asB.get('/policies').expect(200);
      const policyRows = Array.isArray(policies.body) ? policies.body : policies.body.data;
      expect(policyRows.some((p: { id: string }) => p.id === policyAId)).toBe(false);
    });
  });

  describe('LMS — courses + enrollments', () => {
    it('list: tenant B never sees tenant A courses', async () => {
      const res = await asB.get('/lms/courses').expect(200);
      const rows = Array.isArray(res.body) ? res.body : res.body.data;
      expect(rows.some((c: { id: string }) => c.id === courseAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A course by id', async () => {
      const res = await asB.get(`/lms/courses/${courseAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it('list + get-by-id: tenant B never sees tenant A enrollments', async () => {
      const list = await asB.get('/lms/enrollments').expect(200);
      const rows = Array.isArray(list.body) ? list.body : list.body.data;
      expect(rows.some((e: { id: string }) => e.id === enrollmentAId)).toBe(false);

      const byId = await asB.get(`/lms/enrollments/${enrollmentAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(byId.status);
    });
  });

  describe('integrations — webhook subscriptions + API keys (incl. the SEPARATE /v1 X-Api-Key path)', () => {
    it('list: tenant B never sees tenant A webhook subscriptions', async () => {
      const res = await asB.get('/integrations/webhooks/subscriptions').expect(200);
      expect(res.body.some((s: { id: string }) => s.id === webhookSubAId)).toBe(false);
    });

    it('mutation-non-landing: tenant B cannot pause tenant A webhook subscription, and it is provably unchanged', async () => {
      const res = await asB.put(`/integrations/webhooks/subscriptions/${webhookSubAId}`, { status: 'PAUSED' });
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: webhookSubAId } });
      expect(stillReal.status).toBe('ACTIVE');
    });

    it('list: tenant B never sees tenant A API keys', async () => {
      const res = await asB.get('/integrations/api-keys').expect(200);
      expect(res.body.some((k: { id: string }) => k.id === apiKeyAId)).toBe(false);
    });

    it('mutation-non-landing: tenant B cannot revoke tenant A API key, and the key still authenticates as tenant A afterward', async () => {
      const res = await asB.delete(`/integrations/api-keys/${apiKeyAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);

      const stillReal = await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKeyAId } });
      expect(stillReal.status).toBe('ACTIVE');
      expect(stillReal.revokedAt).toBeNull();
    });

    it('a tenant-A-scoped API key (a SEPARATE auth path from JWT — no Host/Authorization at all) can read tenant A employees via /v1, never tenant B', async () => {
      const res = await request(app.getHttpServer()).get('/v1/employees').set('X-Api-Key', apiKeyARawKey).expect(200);
      expect(res.body.data.some((e: { id: string }) => e.id === employeeAId)).toBe(true);
      expect(res.body.data.some((e: { id: string }) => e.id === employeeBId)).toBe(false);

      // Same key, direct-by-id against tenant B's own employee — must 404,
      // not silently return tenant B's row.
      await request(app.getHttpServer()).get(`/v1/employees/${employeeBId}`).set('X-Api-Key', apiKeyARawKey).expect(404);
    });
  });

  describe('billing — subscription/invoices (read-only — no mutation attempted against real Stripe-adjacent state)', () => {
    it("GET /billing/summary for tenant B never reflects tenant A's subscription/edition choice", async () => {
      // Both tenants share the SAME edition (ENTERPRISE, set in beforeAll for
      // licensing reasons) — the isolation proof here is that each tenant's
      // summary is independently computed from ITS OWN Subscription row
      // (RLS), not that the values happen to differ.
      const summaryA = await asA.get('/billing/summary').expect(200);
      const summaryB = await asB.get('/billing/summary').expect(200);
      expect(summaryA.body.subscription.edition).toBe('ENTERPRISE');
      expect(summaryB.body.subscription.edition).toBe('ENTERPRISE');

      const subA = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      const subB = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantBId } });
      expect(subA.id).not.toBe(subB.id);
    });
  });

  describe('branding — tenant branding config', () => {
    it("GET /branding never leaks tenant A's product name under tenant B's Host", async () => {
      const underA = await request(app.getHttpServer()).get('/branding').set('Host', hostFor(TENANT_A_SLUG)).expect(200);
      expect(underA.body.productName).toBe('Iso A Confidential Brand');

      const underB = await request(app.getHttpServer()).get('/branding').set('Host', hostFor(TENANT_B_SLUG)).expect(200);
      expect(underB.body.productName).not.toBe('Iso A Confidential Brand');
    });

    it("GET /branding/settings (authenticated) for tenant B never reflects tenant A's row", async () => {
      const res = await asB.get('/branding/settings').expect(200);
      expect(res.body.productName).not.toBe('Iso A Confidential Brand');
    });

    // No mutation-non-landing test here: branding has no :id in its URL at
    // all — it is implicitly scoped to the CALLER's own tenant by
    // TenantContextService, so there is no cross-tenant id for tenant B to
    // even attempt to address; the GET checks above are the isolation
    // proof for this module.
  });

  describe('migration — import batches (lighter: seeded directly; the real dry-run/commit flow is proven in migration.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A import batches', async () => {
      const res = await asB.get('/migration/batches').expect(200);
      expect(res.body.some((b: { id: string }) => b.id === importBatchAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A import batch by id', async () => {
      const res = await asB.get(`/migration/batches/${importBatchAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('benefits — plans + enrollments', () => {
    it('list: tenant B never sees tenant A benefit plans', async () => {
      const res = await asB.get('/benefits/plans').expect(200);
      expect(res.body.some((p: { id: string }) => p.id === benefitPlanAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A benefit plan by id', async () => {
      const res = await asB.get(`/benefits/plans/${benefitPlanAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });

    it('list + get-by-id: tenant B never sees tenant A benefit enrollments', async () => {
      const list = await asB.get('/benefits/enrollments').expect(200);
      expect(list.body.some((e: { id: string }) => e.id === benefitEnrollmentAId)).toBe(false);

      const byId = await asB.get(`/benefits/enrollments/${benefitEnrollmentAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(byId.status);
    });
  });

  describe('e-signature — signature requests (lighter: seeded directly; the full signing + evidentiary trail is proven in esignature.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A signature requests', async () => {
      const res = await asB.get('/e-signatures/requests').expect(200);
      expect(res.body.some((r: { id: string }) => r.id === signatureRequestAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A signature request by id', async () => {
      const res = await asB.get(`/e-signatures/requests/${signatureRequestAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('statutory reporting — generated reports (lighter: reuses the global catalog row; the real generation pipeline is proven in statutory-reporting.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A generated reports', async () => {
      const res = await asB.get('/statutory-reports').expect(200);
      expect(res.body.some((r: { id: string }) => r.id === generatedReportAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A generated report by id', async () => {
      const res = await asB.get(`/statutory-reports/${generatedReportAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('privacy — data subject requests (lighter: seeded directly; the real export/erasure engine is proven in privacy-residency.e2e-spec.ts)', () => {
    it('list: tenant B never sees tenant A data subject requests', async () => {
      const res = await asB.get('/privacy/requests').expect(200);
      expect(res.body.some((r: { id: string }) => r.id === dataSubjectRequestAId)).toBe(false);
    });

    it('get-by-id: tenant B cannot read tenant A data subject request by id', async () => {
      const res = await asB.get(`/privacy/requests/${dataSubjectRequestAId}`);
      expect(CROSS_TENANT_STATUSES).toContain(res.status);
    });
  });

  describe('custom fields — definitions', () => {
    it("tenant B never sees tenant A's custom field definition for Employee", async () => {
      const res = await asB.get('/custom-fields/definitions/Employee').expect(200);
      expect(res.body.some((d: { fieldKey: string }) => d.fieldKey === 'iso_isolation_test')).toBe(false);
    });
  });

  describe("audit — log entries (tenant B must never see tenant A's audit trail)", () => {
    it("tenant A's own audit log contains entries from this fixture's real mutations (positive control)", async () => {
      const res = await asA.get('/audit?entityType=Employee').expect(200);
      expect(res.body.some((entry: { entityId: string | null }) => entry.entityId === employeeAId)).toBe(true);
    });

    it('tenant B never sees any tenant-A entity id in its own audit log', async () => {
      const res = await asB.get('/audit').expect(200);
      const entityIds = res.body.map((entry: { entityId: string | null }) => entry.entityId);
      expect(entityIds).not.toContain(employeeAId);
      expect(entityIds).not.toContain(webhookSubAId);
      expect(entityIds).not.toContain(benefitPlanAId);
    });

    it("tenant B never sees tenant A's actor user id in its own audit log", async () => {
      const res = await asB.get('/audit').expect(200);
      expect(res.body.some((entry: { actorUserId: string | null }) => entry.actorUserId === adminAUserId)).toBe(false);
    });
  });

  describe('analytics — dashboard rollups (lighter: one real snapshot row; the scheduled rollup job itself is proven in analytics.e2e-spec.ts)', () => {
    it("tenant B's dashboard reflects ONLY tenant B's own (empty) data, never tenant A's seeded headcount snapshot", async () => {
      const res = await asB.get('/analytics/dashboard?from=2020-01-01&to=2030-01-01').expect(200);
      expect(res.body.headcount.total).toBe(0);
    });

    it("tenant A's own dashboard DOES reflect its seeded headcount snapshot (positive control)", async () => {
      const res = await asA.get('/analytics/dashboard?from=2020-01-01&to=2030-01-01').expect(200);
      expect(res.body.headcount.total).toBeGreaterThanOrEqual(777);
    });
  });
});
