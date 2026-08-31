import { writeFileSync } from 'fs';
import { hash } from '@node-rs/argon2';
import { prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
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

  const tenantA = await prisma.tenant.create({
    data: { name: 'Portal E2E Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'Portal E2E Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });

  await seedCountryPacks(prisma);
  await seedSystemRolesAndPermissions(prisma, tenantA.id);
  await seedSystemRolesAndPermissions(prisma, tenantB.id);

  const branchAUs = await prisma.branch.create({
    data: { tenantId: tenantA.id, name: 'Portal E2E US HQ', countryCode: 'US', timezone: 'America/New_York' },
  });
  const branchAQa = await prisma.branch.create({
    data: { tenantId: tenantA.id, name: 'Portal E2E Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
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
  await makeUser(tenantA.id, 'admin@portal-e2e-a.test', adminRoleA.id);

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
  await prisma.employee.create({
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
  ] as const) {
    const template = await prisma.workflowTemplate.create({
      data: { tenantId, name: `${entityType} approval`, entityType, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId, templateId: template.id, name: 'Manager approval', order: 1, approverRule: { type: 'MANAGER' } },
    });
  }

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

  const fixtures = {
    tenantASlug: TENANT_A_SLUG,
    tenantBSlug: TENANT_B_SLUG,
    adminAEmail: 'admin@portal-e2e-a.test',
    managerAEmail: 'manager@portal-e2e-a.test',
    branchRestrictedManagerEmail: 'branch-restricted-manager@portal-e2e-a.test',
    employeeAEmail: 'employee@portal-e2e-a.test',
    qaEmployeeAEmail: 'qa-employee@portal-e2e-a.test',
    employeeAId: employeeAEmployee.id,
    employeeASalary,
    employeeBEmail: 'employee@portal-e2e-b.test',
    branchAUsId: branchAUs.id,
    branchAQaId: branchAQa.id,
    analyticsDate: analyticsDate.toISOString().slice(0, 10),
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  await prisma.$disconnect();
}
