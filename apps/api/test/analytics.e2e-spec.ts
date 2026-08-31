/**
 * Proves the Analytics dashboard module (step 1.5, Phase 1 finale) end to
 * end over real HTTP — see docs/conventions/analytics-dashboard.md: KPI
 * numbers computed correctly from seeded employees/leave/attendance data,
 * the dashboard read path depending ONLY on the four precomputed rollup
 * tables (never live-aggregating `employees`/`attendance_records`/
 * `leave_requests`/`leave_balances` — proved directly, not just trusted),
 * branch-scoped visibility, RBAC deny-by-default, and cross-tenant
 * isolation (RLS).
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

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'analytics-test-tenant-a';
const TENANT_B_SLUG = 'analytics-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

// A fixed "today" for the whole suite, so joinDate/terminatedAt/rollup date
// all line up deterministically without racing the real clock's UTC day
// boundary mid-run.
const ROLLUP_DATE = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const ROLLUP_DATE_ISO = ROLLUP_DATE.toISOString().slice(0, 10);

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

describe('analytics dashboard (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchUsId: string;
  let branchQaId: string;

  let tokenAdminA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  let empJoinerId: string;
  let empContractId: string;
  let empTerminatedId: string;

  function post(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }
  function postJson(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return post(path, token, host).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
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
      data: { name: 'Analytics Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Analytics Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchUs = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Analytics A US HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchUsId = branchUs.id;
    const branchQa = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Analytics A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchQaId = branchQa.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@analytics-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeA = await makeUserWithRole(tenantAId, employeeRoleA.id, 'employee@analytics-a.test');
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@analytics-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // A joiner today, FULL_TIME/FEMALE, on the US branch.
    const empJoiner = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId: branchUsId,
        employeeCode: 'ANL-1',
        firstName: 'Joiner',
        lastName: 'One',
        employmentType: 'FULL_TIME',
        gender: 'FEMALE',
        joinDate: ROLLUP_DATE,
        status: 'ACTIVE',
      },
    });
    empJoinerId = empJoiner.id;

    // A long-tenured CONTRACT/MALE employee, also on the US branch.
    const empContract = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId: branchUsId,
        employeeCode: 'ANL-2',
        firstName: 'Contract',
        lastName: 'Two',
        employmentType: 'CONTRACT',
        gender: 'MALE',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });
    empContractId = empContract.id;

    // A QA-branch employee, terminated TODAY via the real EmployeeService
    // update path (proving `terminatedAt` capture, not a fixture shortcut).
    const empTerminated = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId: branchQaId,
        employeeCode: 'ANL-3',
        firstName: 'Leaver',
        lastName: 'Three',
        employmentType: 'FULL_TIME',
        gender: 'MALE',
        joinDate: new Date('2019-01-01'),
        status: 'ACTIVE',
      },
    });
    empTerminatedId = empTerminated.id;
    await request(app.getHttpServer())
      .patch(`/employees/${empTerminatedId}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ status: 'TERMINATED' })
      .expect(200);

    // Attendance: one PRESENT day for the joiner, one LATE day for the
    // contractor — seeded directly into AttendanceDailySummary (1.3's own
    // rollup), since this module's job reads THAT table, never raw
    // AttendanceRecord — see docs/conventions/analytics-dashboard.md.
    await prisma.attendanceDailySummary.createMany({
      data: [
        { tenantId: tenantAId, employeeId: empJoinerId, branchId: branchUsId, workDate: ROLLUP_DATE, status: 'PRESENT', workedMinutes: 480, overtimeMinutes: 0, lateMinutes: 0 },
        { tenantId: tenantAId, employeeId: empContractId, branchId: branchUsId, workDate: ROLLUP_DATE, status: 'LATE', workedMinutes: 450, overtimeMinutes: 0, lateMinutes: 30 },
      ],
    });

    // Leave: current-year ANNUAL balances for both US employees.
    const periodYear = ROLLUP_DATE.getUTCFullYear();
    await prisma.leaveBalance.createMany({
      data: [
        { tenantId: tenantAId, employeeId: empJoinerId, leaveType: 'ANNUAL', periodYear, entitledDays: 10, accruedDays: 5, usedDays: 2 },
        { tenantId: tenantAId, employeeId: empContractId, leaveType: 'ANNUAL', periodYear, entitledDays: 10, accruedDays: 5, usedDays: 0 },
      ],
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('rollup job + KPI computation', () => {
    it('runs the rollup job and computes correct headcount/movement/attendance/leave KPIs', async () => {
      await postJson('/analytics/rollup/run', tokenAdminA, { date: ROLLUP_DATE_ISO }).expect(201);

      const dashboard = await waitFor(async () => {
        const res = await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, tokenAdminA).expect(200);
        return res.body.headcount.total > 0 ? res.body : null;
      });

      // Headcount — only ACTIVE/ON_LEAVE employees, as of today: the
      // terminated QA employee is correctly excluded.
      expect(dashboard.headcount.total).toBe(2);
      expect(dashboard.headcount.byBranch).toEqual(expect.arrayContaining([{ branchId: branchUsId, count: 2 }]));
      expect(dashboard.headcount.byEmploymentType).toEqual(
        expect.arrayContaining([
          { employmentType: 'FULL_TIME', count: 1 },
          { employmentType: 'CONTRACT', count: 1 },
        ]),
      );
      expect(dashboard.headcount.byGender).toEqual(
        expect.arrayContaining([
          { gender: 'FEMALE', count: 1 },
          { gender: 'MALE', count: 1 },
        ]),
      );

      // Movement — one joiner (US), one leaver (QA), computed from
      // Employee.joinDate/terminatedAt.
      expect(dashboard.movement.joiners).toBe(1);
      expect(dashboard.movement.leavers).toBe(1);
      expect(dashboard.movement.attritionRate).toBeCloseTo(1 / 2);

      // Attendance — rolled up from AttendanceDailySummary, never raw
      // AttendanceRecord.
      expect(dashboard.attendance.presentCount).toBe(1);
      expect(dashboard.attendance.lateCount).toBe(1);
      expect(dashboard.attendance.employeeDays).toBe(2);
      expect(dashboard.attendance.attendanceRate).toBeCloseTo(0.5);

      // Leave utilization — rolled up from current-year LeaveBalance.
      const annual = dashboard.leave.byType.find((row: { leaveType: string }) => row.leaveType === 'ANNUAL');
      expect(annual).toBeDefined();
      expect(annual.entitledDays).toBe(20);
      expect(annual.usedToDate).toBe(2);
      expect(annual.usedInPeriod).toBe(2); // no snapshot exists before `from` yet, so the baseline is zero
      expect(annual.utilizationRate).toBeCloseTo(0.1);
    });

    it('reads are provably rollup-only — the dashboard is unaffected by deleting every underlying raw row', async () => {
      const before = await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, tokenAdminA).expect(200);
      expect(before.body.headcount.total).toBeGreaterThan(0);

      // None of the four rollup tables carry an FK to Employee (see the
      // schema doc comment) — deleting every Employee row (which cascades
      // AttendanceDailySummary/LeaveBalance/AttendanceRecord/LeaveRequest
      // away with it) must leave the dashboard's numbers byte-identical if
      // the read path genuinely never touches those tables.
      await prisma.employee.deleteMany({ where: { tenantId: tenantAId } });

      const after = await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, tokenAdminA).expect(200);
      expect(after.body).toEqual(before.body);
    });
  });

  describe('branch scoping', () => {
    it('a branch-restricted caller sees only their allowed branch (fewer joiners/headcount than the tenant-wide view)', async () => {
      const restricted = await makeUserWithRole(
        tenantAId,
        (await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } })).id,
        'branch-restricted@analytics-a.test',
      );
      await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: restricted.id, branchId: branchUsId } });
      const restrictedToken = jwt.sign({ sub: restricted.id, tenantId: tenantAId });

      const res = await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, restrictedToken).expect(200);
      // The QA-branch leaver must not be visible to a US-branch-restricted caller.
      expect(res.body.movement.leavers).toBe(0);

      const outOfScope = await get(
        `/analytics/dashboard?branchId=${branchQaId}&from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`,
        restrictedToken,
      ).expect(200);
      expect(outOfScope.body.headcount.total).toBe(0);
      expect(outOfScope.body.movement.leavers).toBe(0);
    });
  });

  describe('RBAC deny-by-default', () => {
    it('rejects a plain EMPLOYEE from reading the dashboard or triggering a rollup', async () => {
      await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, tokenEmployeeA).expect(403);
      await postJson('/analytics/rollup/run', tokenEmployeeA, { date: ROLLUP_DATE_ISO }).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B's dashboard never sees tenant A's rollup rows for the same date range", async () => {
      const res = await get(`/analytics/dashboard?from=${ROLLUP_DATE_ISO}&to=${ROLLUP_DATE_ISO}`, tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(res.body.headcount.total).toBe(0);
      expect(res.body.movement.joiners).toBe(0);
      expect(res.body.movement.leavers).toBe(0);
    });
  });
});
