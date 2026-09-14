import { writeFileSync } from 'fs';
import { hash } from '@node-rs/argon2';
import { prisma, seedCountryPacks, seedStatutoryReportDefinitions, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { FIXTURES_PATH, TEST_PASSWORD } from './fixtures';

const ARGON2ID = 2;

const TENANT_A_SLUG = 'portal-e2e-a';
const TENANT_B_SLUG = 'portal-e2e-b';

/**
 * Seeds the real fixtures every spec in this suite runs against — a real
 * tenant, real branches (one per timezone/Country Pack, matching the
 * US-vs-QA proof every other phase's e2e suite already relies on), real
 * roles/permissions (the SAME `seedSystemRolesAndPermissions` helper
 * `apps/api/test/*.e2e-spec.ts` uses), a real MANAGER-rule workflow
 * template for both `LeaveRequest` and `AttendanceRegularization` (THE
 * RULE — see docs/conventions/workflow.md — there is no other way to get
 * an approval chain), and real argon2-hashed passwords so the actual
 * `/auth/login` flow can be exercised end to end, not bypassed with a
 * signed JWT the way the API's own faster e2e suite does.
 *
 * Writes the created ids/emails to `.fixtures.json` for spec files to read
 * — Playwright's `globalSetup` runs in its own process, so there is no
 * other way to hand this to the test files.
 */
export default async function globalSetup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });

  // `edition: 'ENTERPRISE'` (not just the `multi_country_payroll` feature-
  // flag override below) — `TenantRateLimitService.enforce` (0.10) reads
  // `Tenant.edition` directly for its per-tenant request-volume quota
  // (`DEFAULT_RATE_LIMITS`: STARTER 200 req/60s, ENTERPRISE 2000/60s), a
  // SEPARATE mechanism from feature flags. This suite's own volume (many
  // full page reloads × several concurrent fetches each, plus polling
  // loops) legitimately exceeds STARTER's quota — a real resilience
  // control working as designed, not a bug — so the fixture tenants need
  // the higher tier the same way a real high-traffic tenant would.
  const tenantA = await prisma.tenant.create({
    data: { name: 'Portal E2E Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', edition: 'ENTERPRISE' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'Portal E2E Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', edition: 'ENTERPRISE' },
  });

  await seedCountryPacks(prisma);
  // Step 3.5.4 (statutory/government reporting) — see
  // docs/conventions/statutory-reporting.md; seeds the PK report catalog
  // `statutory-reports.spec.ts` reads through `/statutory-reports/definitions`.
  await seedStatutoryReportDefinitions(prisma);
  await seedSystemRolesAndPermissions(prisma, tenantA.id);
  await seedSystemRolesAndPermissions(prisma, tenantB.id);

  const branchAUs = await prisma.branch.create({
    data: { tenantId: tenantA.id, name: 'Portal E2E US HQ', countryCode: 'US', timezone: 'America/New_York' },
  });
  const branchAQa = await prisma.branch.create({
    data: { tenantId: tenantA.id, name: 'Portal E2E Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
  });
  // Step 3.5.4 — a PK branch for `statutory-reports.spec.ts`'s own
  // generate+download+RTL proof (the Pakistan pack's own compliance
  // boundary — see docs/conventions/pakistan-pack.md).
  const branchAPk = await prisma.branch.create({
    data: { tenantId: tenantA.id, name: 'Portal E2E Karachi Office', countryCode: 'PK', timezone: 'Asia/Karachi' },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenantB.id, name: 'Portal E2E Tenant B HQ', countryCode: 'US', timezone: 'America/New_York' },
  });

  const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantA.id, name: SYSTEM_ROLES.TENANT_ADMIN } } });
  const managerRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantA.id, name: SYSTEM_ROLES.MANAGER } } });
  const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantA.id, name: SYSTEM_ROLES.EMPLOYEE } } });
  const employeeRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantB.id, name: SYSTEM_ROLES.EMPLOYEE } } });

  const hashedPassword = await hash(TEST_PASSWORD, { algorithm: ARGON2ID });

  async function makeUser(tenantId: string, email: string, roleId: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword, status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  // TENANT_ADMIN holds every permission including salary.view — used only
  // to seed compensation onto employeeA through a real PATCH (so the
  // encrypt-then-field-gate path is exercised for real, not faked), since
  // MANAGER does NOT hold salary.view (see packages/shared's
  // SYSTEM_ROLE_PERMISSIONS) and would have the value omitted from its own
  // PATCH response too.
  const adminAUser = await makeUser(tenantA.id, 'admin@portal-e2e-a.test', adminRoleA.id);

  const managerAUser = await makeUser(tenantA.id, 'manager@portal-e2e-a.test', managerRoleA.id);
  const managerAEmployee = await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: managerAUser.id,
      employeeCode: 'PE-MGR-1',
      firstName: 'Mona',
      lastName: 'Manager',
      branchId: branchAUs.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2020-01-01'),
      statutoryFields: { SSN: '000-00-0001', W4: 'on-file' },
    },
  });

  // Compensation is deliberately NOT set here via a raw Prisma write — it
  // must go through `EmployeeService`'s own encryption so a test asserting
  // "salary is hidden without salary.view" is exercising the real
  // encrypt-then-field-gate path, not a fixture shortcut. `employee-e2e.spec.ts`
  // sets it via a real `PATCH /employees/:id` call (as managerA, who holds
  // `employee.write`) before asserting on it.
  const employeeASalary = 72000;
  const employeeAUser = await makeUser(tenantA.id, 'employee@portal-e2e-a.test', employeeRoleA.id);
  const employeeAEmployee = await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: employeeAUser.id,
      employeeCode: 'PE-EMP-1',
      firstName: 'Eve',
      lastName: 'Employee',
      branchId: branchAUs.id,
      managerId: managerAEmployee.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2022-03-01'),
      statutoryFields: { SSN: '000-00-0002', W4: 'on-file' },
    },
  });

  const qaEmployeeAUser = await makeUser(tenantA.id, 'qa-employee@portal-e2e-a.test', employeeRoleA.id);
  const qaEmployeeAEmployee = await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: qaEmployeeAUser.id,
      employeeCode: 'PE-QA-1',
      firstName: 'Amal',
      lastName: 'Al-Qatari',
      branchId: branchAQa.id,
      managerId: managerAEmployee.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2022-06-01'),
      statutoryFields: { QATAR_ID: 'QID-000001', VISA_SPONSORSHIP: 'yes' },
    },
  });

  // Step 3.5.4 — a PK employee `statutory-reports.spec.ts` runs a real,
  // finalized payroll period against (via direct API calls in its own
  // setup, mirroring payroll.spec.ts's own "arrange via API, act via UI"
  // shape) so a report generated through the UI has real per-employee
  // CNIC/NTN/gross/tax-withheld data to show, not an empty run.
  const pkEmployeeAUser = await makeUser(tenantA.id, 'pk-employee@portal-e2e-a.test', employeeRoleA.id);
  const pkEmployeeAEmployee = await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: pkEmployeeAUser.id,
      employeeCode: 'PE-PK-1',
      firstName: 'Bilal',
      lastName: 'Ahmed',
      branchId: branchAPk.id,
      managerId: managerAEmployee.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2022-06-01'),
      statutoryFields: { CNIC: '42101-7654321-0', NTN: '1234567-8' },
    },
  });

  const branchRestrictedManagerUser = await makeUser(tenantA.id, 'branch-restricted-manager@portal-e2e-a.test', managerRoleA.id);
  await prisma.userBranch.create({ data: { tenantId: tenantA.id, userId: branchRestrictedManagerUser.id, branchId: branchAUs.id } });
  await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: branchRestrictedManagerUser.id,
      employeeCode: 'PE-MGR-2',
      firstName: 'Rana',
      lastName: 'Restricted',
      branchId: branchAUs.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2020-01-01'),
      statutoryFields: { SSN: '000-00-0004', W4: 'on-file' },
    },
  });

  // A DEDICATED employee for the offboarding flow — never used by any other
  // spec. `OffboardingService.complete` disables the employee's linked
  // `User` account (`status: 'DISABLED'`, all tokens revoked) as one of its
  // real side effects, so reusing `employeeAEmployee` (logged into by
  // `payroll.spec.ts`/`performance.spec.ts`'s own RBAC checks, which may
  // run AFTER this suite's offboarding test under `workers: 1`) would break
  // those specs. `managerId` is set to `managerAEmployee` so `MANAGER`-rule
  // approval resolves to `managerAUser`, matching the OffboardingProcess
  // workflow template above.
  const offboardingTargetUser = await makeUser(tenantA.id, 'offboarding-target@portal-e2e-a.test', employeeRoleA.id);
  const offboardingTargetEmployee = await prisma.employee.create({
    data: {
      tenantId: tenantA.id,
      userId: offboardingTargetUser.id,
      employeeCode: 'PE-OFFB-1',
      firstName: 'Omar',
      lastName: 'Offboarding',
      branchId: branchAUs.id,
      managerId: managerAEmployee.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2021-05-01'),
      statutoryFields: { SSN: '000-00-0005', W4: 'on-file' },
    },
  });

  const employeeBUser = await makeUser(tenantB.id, 'employee@portal-e2e-b.test', employeeRoleB.id);
  await prisma.employee.create({
    data: {
      tenantId: tenantB.id,
      userId: employeeBUser.id,
      employeeCode: 'PE-B-1',
      firstName: 'Bao',
      lastName: 'BTenant',
      branchId: branchB.id,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2023-01-01'),
      statutoryFields: { SSN: '000-00-0003', W4: 'on-file' },
    },
  });

  for (const [tenantId, entityType] of [
    [tenantA.id, 'LeaveRequest'],
    [tenantA.id, 'AttendanceRegularization'],
    // `AppraisalService.submitForApproval` passes the APPRAISED EMPLOYEE's
    // own linked `User.id` as `requesterId` (see docs/conventions/
    // performance.md) — unlike PayrollRun's `ROLE` template below — so a
    // `MANAGER` rule correctly resolves through the real org chart, exactly
    // like LeaveRequest/AttendanceRegularization's own templates. employeeA
    // already has managerA as its manager (seeded above), so submitting an
    // appraisal for employeeA resolves to managerAUser as the approver.
    [tenantA.id, 'PerformanceAppraisal'],
    // `OffboardingService.initiate` passes the DEPARTING EMPLOYEE's own
    // linked `User.id` as `requesterId` (see docs/conventions/
    // recruitment-lifecycle.md — the SAME "requester = the subject"
    // reuse Leave/Attendance/Performance already establish above), so a
    // `MANAGER` rule correctly resolves through the real org chart —
    // employeeA already has managerA as its manager, so initiating
    // offboarding for employeeA resolves to managerAUser as the approver.
    [tenantA.id, 'OffboardingProcess'],
    // Operations modules (step 3.1) — `ExpenseClaimService.submit` passes
    // the CLAIMANT's own linked `User.id` as `requesterId`, the SAME
    // "requester = the subject" reuse every other module above already
    // establishes, so a `MANAGER` rule resolves through the real org
    // chart exactly like LeaveRequest's own template — no HR-conditional
    // step needed here: that branching is already proven end to end at
    // the API level (see apps/api/test/operations-modules.e2e-spec.ts);
    // this suite's own expense spec only needs to prove the UI WIRING.
    [tenantA.id, 'EXPENSE_CLAIM'],
  ] as const) {
    const template = await prisma.workflowTemplate.create({
      data: { tenantId, name: `${entityType} approval`, entityType, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId, templateId: template.id, name: 'Manager approval', order: 1, approverRule: { type: 'MANAGER' } },
    });
  }

  // PayrollRun's own approval template — deliberately a `ROLE` rule
  // (TENANT_ADMIN), not `MANAGER` like the two templates above:
  // `PayrollRunService.submitForApproval` passes the CALLER (whoever
  // clicked "submit", i.e. an HR/admin user) as `requesterId`, not an
  // Employee with an org-chart manager, so a `MANAGER` rule would resolve
  // to zero eligible approvers for `admin@portal-e2e-a.test` (a
  // TENANT_ADMIN-only account with no linked Employee record). A `ROLE`
  // rule against TENANT_ADMIN lets that same admin approve their own
  // submitted run directly — see docs/conventions/workflow.md's
  // `ApproverRule` shapes (`apps/api/src/workflow/approver-resolver.service.ts`).
  const payrollTemplate = await prisma.workflowTemplate.create({
    data: { tenantId: tenantA.id, name: 'PayrollRun approval', entityType: 'PayrollRun', version: 1, isActive: true },
  });
  await prisma.workflowStep.create({
    data: {
      tenantId: tenantA.id,
      templateId: payrollTemplate.id,
      name: 'Admin approval',
      order: 1,
      approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN },
    },
  });

  // `JobRequisitionService.submitForApproval`/`OfferService.submitForApproval`
  // both pass the CALLER (an HR/admin user, e.g. `admin@portal-e2e-a.test`)
  // as `requesterId` — same reasoning as PayrollRun's own template above,
  // not `MANAGER` (that admin account has no linked Employee/org-chart
  // manager). A `ROLE:TENANT_ADMIN` rule lets that same admin approve their
  // own submitted requisition/offer directly via the inline
  // `WorkflowStatusPanel` on `/recruitment` — `recruitment.read` (which
  // gates `GET requisitions/:id`/`GET offers/:id`) is held by TENANT_ADMIN/
  // HR_MANAGER/MANAGER alike with no additional row-level ownership check
  // (confirmed by reading `recruitment.controller.ts`), so this is safe.
  for (const [tenantId, entityType] of [
    [tenantA.id, 'JobRequisition'],
    [tenantA.id, 'Offer'],
  ] as const) {
    const template = await prisma.workflowTemplate.create({
      data: { tenantId, name: `${entityType} approval`, entityType, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: {
        tenantId,
        templateId: template.id,
        name: 'Admin approval',
        order: 1,
        approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN },
      },
    });
  }

  // The `multi_country_payroll` feature flag is ENTERPRISE-only and the
  // fixture tenant defaults to STARTER — enable it directly for tenant A,
  // mirroring apps/api/test/payroll.e2e-spec.ts's own setup.
  await prisma.tenantFeatureFlagOverride.create({ data: { tenantId: tenantA.id, flagKey: 'multi_country_payroll', enabled: true } });

  // A minimal custom role holding `payroll.run` but NOT `salary.view` — no
  // seeded system role has exactly this combination (TENANT_ADMIN/
  // HR_MANAGER hold both, MANAGER/EMPLOYEE hold neither) — needed for a
  // clean field-omission proof on the payroll screens.
  const payrollRunPermission = await prisma.permission.findUniqueOrThrow({
    where: { tenantId_key: { tenantId: tenantA.id, key: 'payroll.run' } },
  });
  const payrollNoSalaryRole = await prisma.role.create({
    data: { tenantId: tenantA.id, name: 'Payroll Runner (no salary view)', isSystem: false },
  });
  await prisma.rolePermission.create({
    data: { tenantId: tenantA.id, roleId: payrollNoSalaryRole.id, permissionId: payrollRunPermission.id },
  });
  await makeUser(tenantA.id, 'payroll-no-salary@portal-e2e-a.test', payrollNoSalaryRole.id);

  // Analytics dashboard (step 1.5) rollup rows, seeded DIRECTLY into the
  // four precomputed tables rather than via the real BullMQ job — this
  // suite's job is proving the UI RENDERS rollup data correctly (locale/
  // RTL/branch-scoping), not re-proving the rollup computation itself,
  // which apps/api/test/analytics.e2e-spec.ts already covers end to end.
  // Dated "yesterday" (UTC) — the dashboard's own default `to`, so no
  // spec needs to touch the date filters at all.
  const analyticsDate = new Date();
  analyticsDate.setUTCDate(analyticsDate.getUTCDate() - 1);
  analyticsDate.setUTCHours(0, 0, 0, 0);

  await prisma.headcountDailySnapshot.createMany({
    data: [
      { tenantId: tenantA.id, snapshotDate: analyticsDate, branchId: branchAUs.id, employmentType: 'FULL_TIME', gender: 'FEMALE', activeCount: 2 },
      { tenantId: tenantA.id, snapshotDate: analyticsDate, branchId: branchAUs.id, employmentType: 'FULL_TIME', gender: 'MALE', activeCount: 1 },
      { tenantId: tenantA.id, snapshotDate: analyticsDate, branchId: branchAQa.id, employmentType: 'FULL_TIME', gender: 'MALE', activeCount: 1 },
    ],
  });
  await prisma.workforceMovementDailyCount.createMany({
    data: [
      { tenantId: tenantA.id, movementDate: analyticsDate, branchId: branchAUs.id, movementType: 'JOINER', count: 2 },
      { tenantId: tenantA.id, movementDate: analyticsDate, branchId: branchAUs.id, movementType: 'LEAVER', count: 1 },
      { tenantId: tenantA.id, movementDate: analyticsDate, branchId: branchAQa.id, movementType: 'LEAVER', count: 1 },
    ],
  });
  await prisma.attendanceDailyBranchSummary.createMany({
    data: [
      {
        tenantId: tenantA.id,
        workDate: analyticsDate,
        branchId: branchAUs.id,
        presentCount: 5,
        absentCount: 1,
        lateCount: 2,
        employeeCount: 8,
        totalWorkedMinutes: 2400,
      },
    ],
  });
  await prisma.leaveUtilizationDailySnapshot.createMany({
    data: [
      {
        tenantId: tenantA.id,
        snapshotDate: analyticsDate,
        branchId: branchAUs.id,
        leaveType: 'ANNUAL',
        totalEntitledDays: 100,
        totalAccruedDays: 60,
        totalUsedDays: 25,
        employeeCount: 10,
      },
    ],
  });

  // Performance (step 2.2) fixtures — see docs/conventions/performance.md.
  // A rating scale is generically reusable across many cycles/specs, so it
  // is seeded directly here (mirroring this file's own "seed once" posture
  // for country packs/roles) rather than driven through the UI's own
  // rating-scale-creation form — `performance.spec.ts` instead asserts the
  // seeded scale is selectable in the cycle-create form, which is enough to
  // prove that wiring without re-authoring a scale per test run.
  const ratingScale = await prisma.ratingScale.create({
    data: {
      tenantId: tenantA.id,
      key: 'portal-e2e-5-point',
      name: 'Portal E2E 5-point scale',
      levels: [
        { value: 1, label: 'Needs improvement' },
        { value: 3, label: 'Meets expectations' },
        { value: 5, label: 'Exceeds expectations' },
      ],
    },
  });

  // A calibration cycle + precomputed `AppraisalRatingDistributionSnapshot`
  // rows, seeded DIRECTLY rather than driven through a full enroll -> peer-
  // assign -> review -> sign-off flow to COMPLETED — this suite's
  // calibration test is proving the UI renders precomputed rollup rows
  // correctly (the same posture `analytics.spec.ts`/this file's own
  // analytics-rollup fixtures already take for themselves), not re-proving
  // `CalibrationProcessor`'s own computation (apps/api/test/performance.e2e-
  // spec.ts already covers that end to end). Kept as its own cycle,
  // separate from whatever cycle `performance.spec.ts` creates through the
  // UI, since global-setup runs before that cycle exists.
  const calibrationCycle = await prisma.appraisalCycle.create({
    data: {
      tenantId: tenantA.id,
      name: 'Portal E2E Calibration Cycle',
      cycleType: 'ANNUAL',
      status: 'CLOSED',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-12-31'),
      ratingScaleId: ratingScale.id,
      enabledReviewTypes: ['SELF', 'MANAGER'],
      eligibleBranchIds: [],
      eligibleDepartmentIds: [],
      openedAt: new Date('2025-01-01'),
      closedAt: new Date('2025-12-31'),
    },
  });
  await prisma.appraisalRatingDistributionSnapshot.createMany({
    data: [
      { tenantId: tenantA.id, cycleId: calibrationCycle.id, branchId: branchAUs.id, departmentId: null, ratingValue: 3, employeeCount: 2 },
      { tenantId: tenantA.id, cycleId: calibrationCycle.id, branchId: branchAUs.id, departmentId: null, ratingValue: 5, employeeCount: 1 },
    ],
  });

  // Recruitment (2.3) fixtures — see docs/conventions/recruitment-lifecycle.md.
  // A `Candidate`+`Application` pair, seeded DIRECTLY via Prisma: the public
  // careers API (the only UI-reachable way to create a `Candidate`) is out
  // of scope for the admin console this stage builds. `Application.
  // jobPostingId` is a required FK, so a minimal already-`APPROVED`
  // `JobRequisition` + `JobPosting` pair is seeded alongside it purely to
  // satisfy that constraint — separate from whatever requisition/posting
  // `recruitment.spec.ts` itself creates and drives through the UI.
  const seededRequisition = await prisma.jobRequisition.create({
    data: {
      tenantId: tenantA.id,
      title: 'Portal E2E Seeded Requisition',
      branchId: branchAUs.id,
      employmentType: 'FULL_TIME',
      headcount: 1,
      status: 'APPROVED',
      createdByUserId: adminAUser.id,
      approvedAt: new Date(),
    },
  });
  const seededPosting = await prisma.jobPosting.create({
    data: {
      tenantId: tenantA.id,
      requisitionId: seededRequisition.id,
      title: 'Portal E2E Seeded Posting',
      description: 'A seeded posting backing the pipeline-board candidate fixture.',
      publicSlug: 'portal-e2e-seeded-posting',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  const seededCandidate = await prisma.candidate.create({
    data: {
      tenantId: tenantA.id,
      firstName: 'Cara',
      lastName: 'Candidate',
      email: 'cara.candidate@portal-e2e-a.test',
      resumeStorageKey: null,
    },
  });
  const seededApplication = await prisma.application.create({
    data: {
      tenantId: tenantA.id,
      candidateId: seededCandidate.id,
      jobPostingId: seededPosting.id,
      stage: 'APPLIED',
    },
  });

  // Onboarding/Offboarding checklist templates (2.3) — `ChecklistService.
  // instantiate` picks the tenant's sole ACTIVE template per `processType`
  // when no `checklistTemplateName` is given, so seeding exactly one of
  // each here makes it the default with no query-param plumbing needed
  // from the UI/tests. Both tasks resolve to `admin@portal-e2e-a.test` via
  // a `ROLE: TENANT_ADMIN` assignee rule — `resolveChecklistAssignee`
  // picks the tenant's earliest-created ACTIVE holder of that role, and
  // the admin account is the first user created for tenant A above — so
  // the same admin login used throughout this suite can complete "my
  // tasks" for both flows, including the one `requiresDocument` task.
  await prisma.checklistTemplate.create({
    data: {
      tenantId: tenantA.id,
      processType: 'ONBOARDING',
      name: 'Portal E2E Onboarding Checklist',
      tasks: [
        { key: 'welcome-pack', title: 'Send welcome pack', category: 'HR', assigneeRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN }, requiresDocument: false },
        { key: 'signed-contract', title: 'Upload signed contract', category: 'HR', assigneeRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN }, requiresDocument: true },
      ],
    },
  });
  await prisma.checklistTemplate.create({
    data: {
      tenantId: tenantA.id,
      processType: 'OFFBOARDING',
      name: 'Portal E2E Offboarding Checklist',
      tasks: [
        { key: 'return-equipment', title: 'Return company equipment', category: 'IT', assigneeRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN }, requiresDocument: false },
        { key: 'exit-interview-form', title: 'Upload signed exit interview form', category: 'HR', assigneeRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN }, requiresDocument: true },
      ],
    },
  });

  const fixtures = {
    tenantASlug: TENANT_A_SLUG,
    tenantBSlug: TENANT_B_SLUG,
    adminAEmail: 'admin@portal-e2e-a.test',
    managerAEmail: 'manager@portal-e2e-a.test',
    branchRestrictedManagerEmail: 'branch-restricted-manager@portal-e2e-a.test',
    employeeAEmail: 'employee@portal-e2e-a.test',
    qaEmployeeAEmail: 'qa-employee@portal-e2e-a.test',
    employeeAId: employeeAEmployee.id,
    // Step 3.5.3 (e-signatures) — an INTERNAL `SignatureSigner.userId` is a
    // real User id, not an Employee id (see docs/conventions/e-signatures.md);
    // this is the one existing fixture employee that already has a linked
    // User, so it's reused here rather than provisioning a new one.
    employeeAUserId: employeeAUser.id,
    employeeASalary,
    employeeBEmail: 'employee@portal-e2e-b.test',
    branchAUsId: branchAUs.id,
    branchAQaId: branchAQa.id,
    branchAPkId: branchAPk.id,
    pkEmployeeAEmail: 'pk-employee@portal-e2e-a.test',
    pkEmployeeAEmployeeId: pkEmployeeAEmployee.id,
    analyticsDate: analyticsDate.toISOString().slice(0, 10),
    payrollNoSalaryEmail: 'payroll-no-salary@portal-e2e-a.test',
    managerAEmployeeId: managerAEmployee.id,
    qaEmployeeAEmployeeId: qaEmployeeAEmployee.id,
    ratingScaleKey: ratingScale.key,
    ratingScaleName: ratingScale.name,
    calibrationCycleId: calibrationCycle.id,
    seededCandidateId: seededCandidate.id,
    seededCandidateName: `${seededCandidate.firstName} ${seededCandidate.lastName}`,
    seededApplicationId: seededApplication.id,
    seededPostingId: seededPosting.id,
    offboardingTargetEmployeeId: offboardingTargetEmployee.id,
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  await prisma.$disconnect();
}
