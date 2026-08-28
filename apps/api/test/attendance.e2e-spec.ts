/**
 * Proves the Attendance & time-tracking module (step 1.3, Phase 1) end to
 * end over real HTTP — see docs/conventions/attendance.md: clock-in/out
 * with optional geo-fencing + selfie capture, pack-driven weekend
 * derivation (US vs. QA, same code), a regularization running through the
 * real 0.7 workflow to the real 1.1 manager (proving both correction
 * application and overtime computation), the biometric device seam,
 * branch-scoped RBAC deny-by-default, cross-tenant isolation (RLS), and the
 * partition-ready/index shape of `attendance_records`.
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
import { ATTENDANCE_REGULARIZATION_ENTITY_TYPE } from '../src/attendance/attendance.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'attendance-test-tenant-a';
const TENANT_B_SLUG = 'attendance-test-tenant-b';

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

describe('attendance (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAUsId: string;
  let branchAQaId: string;
  let branchGeofenceId: string;

  let employeeRoleAId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenNoAttendancePermA: string;
  let tokenAdminB: string;

  let empCounter = 0;
  async function makeEmployee(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    empCounter += 1;
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `ATT-${empCounter}`,
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

  async function employeeWithSelfLogin(tenantId: string, branchId: string, roleId: string, emailSeed: string, overrides: Record<string, unknown> = {}) {
    const user = await makeUserWithRole(tenantId, roleId, `${emailSeed}@attendance-a.test`);
    const employee = await makeEmployee(tenantId, branchId, { userId: user.id, ...overrides });
    const token = jwt.sign({ sub: user.id, tenantId });
    return { user, employee, token };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Attendance Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Attendance Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchAUs = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Attendance A US HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchAUsId = branchAUs.id;
    const branchAQa = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Attendance A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchAQaId = branchAQa.id;
    const branchGeofence = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Attendance A Geofenced Site', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchGeofenceId = branchGeofence.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const hrRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } },
    });
    const adminRoleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const noPermRoleA = await prisma.role.create({ data: { tenantId: tenantAId, name: 'NO_ATTENDANCE_PERMS', isSystem: false } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    employeeRoleAId = employeeRoleA.id;

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@attendance-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@attendance-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });

    const noPermA = await makeUserWithRole(tenantAId, noPermRoleA.id, 'no-perms@attendance-a.test');
    tokenNoAttendancePermA = jwt.sign({ sub: noPermA.id, tenantId: tenantAId });

    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@attendance-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // The default regularization-approval template — see
    // docs/conventions/attendance.md: a regularization just starts a
    // WorkflowInstance under this template, no bespoke approval logic in
    // this module at all.
    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Attendance Regularization Approval', entityType: ATTENDANCE_REGULARIZATION_ENTITY_TYPE, version: 1, isActive: true },
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

  function post(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  function postJson(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return post(path, token, host).send(body);
  }

  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  describe('clock in/out — basic flow', () => {
    it('clocks in, then out, computing worked minutes and closing the record', async () => {
      const { employee, token } = await employeeWithSelfLogin(tenantAId, branchAUsId, employeeRoleAId, 'clock-basic', {});
      const inRes = await post('/attendance/clock-in', token).field('source', 'WEB').expect(201);
      expect(inRes.body.status).toBe('OPEN');
      expect(inRes.body.employeeId).toBe(employee.id);
      expect(inRes.body.clockOutAt).toBeNull();

      const outRes = await post('/attendance/clock-out', token).field('source', 'WEB').expect(201);
      expect(outRes.body.id).toBe(inRes.body.id);
      expect(outRes.body.status).toBe('CLOSED');
      expect(outRes.body.workedMinutes).toBeGreaterThanOrEqual(0);
      expect(outRes.body.clockOutAt).not.toBeNull();
    });

    it('rejects a second clock-in while already clocked in', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchAUsId, employeeRoleAId, 'clock-double', {});
      await post('/attendance/clock-in', token).field('source', 'WEB').expect(201);
      await post('/attendance/clock-in', token).field('source', 'WEB').expect(400);
    });

    it('rejects clock-out with no open clock-in', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchAUsId, employeeRoleAId, 'clock-none', {});
      await post('/attendance/clock-out', token).field('source', 'WEB').expect(404);
    });

    it('captures an optional selfie photo and stores it via StorageService/MinIO', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchAUsId, employeeRoleAId, 'clock-photo', {});
      const photo = Buffer.from('fake-selfie-bytes');
      const res = await post('/attendance/clock-in', token).field('source', 'WEB').attach('photo', photo, 'selfie.jpg').expect(201);
      expect(res.body.status).toBe('OPEN');

      const stored = await prisma.attendanceRecord.findFirst({ where: { id: res.body.id } });
      expect(stored?.clockInPhotoKey).toContain('selfie.jpg');
    });

    it('rejects clock-in without attendance.write (deny-by-default)', async () => {
      await post('/attendance/clock-in', tokenNoAttendancePermA).field('source', 'WEB').expect(403);
    });
  });

  describe('geo-fencing — enforced only when configured on the branch', () => {
    const GEOFENCE_CENTER = { lat: 25.2769, long: 51.52 };

    beforeAll(async () => {
      await postJson(`/attendance/branches/${branchGeofenceId}/geofence`, tokenAdminA, {
        geofenceLat: GEOFENCE_CENTER.lat,
        geofenceLong: GEOFENCE_CENTER.long,
        geofenceRadiusMeters: 200,
      }).expect(201);
    });

    it('rejects a clock-in with no coordinates once geo-fencing is enabled', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchGeofenceId, employeeRoleAId, 'geo-missing', {});
      await post('/attendance/clock-in', token).field('source', 'WEB').expect(400);
    });

    it('rejects a clock-in outside the configured radius', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchGeofenceId, employeeRoleAId, 'geo-outside', {});
      await post('/attendance/clock-in', token)
        .field('source', 'WEB')
        .field('lat', String(GEOFENCE_CENTER.lat + 0.05)) // ~5.5km away, well outside 200m
        .field('long', String(GEOFENCE_CENTER.long))
        .expect(400);
    });

    it('accepts a clock-in inside the configured radius', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchGeofenceId, employeeRoleAId, 'geo-inside', {});
      await post('/attendance/clock-in', token)
        .field('source', 'WEB')
        .field('lat', String(GEOFENCE_CENTER.lat))
        .field('long', String(GEOFENCE_CENTER.long))
        .expect(201);
    });

    it('a branch with no geofence configured accepts a clock-in with no coordinates at all', async () => {
      const { token } = await employeeWithSelfLogin(tenantAId, branchAUsId, employeeRoleAId, 'geo-unconfigured', {});
      await post('/attendance/clock-in', token).field('source', 'WEB').expect(201);
    });
  });

  describe('weekend/working-day derivation — same code, opposite result for US vs. QA', () => {
    it('a Friday is ABSENT (a working day) for a US employee but WEEKEND for a QA employee, from the SAME summary job', async () => {
      const friday = '2026-03-06'; // a Friday not on either reference pack's holiday calendar
      const usEmployee = await makeEmployee(tenantAId, branchAUsId);
      const qaEmployee = await makeEmployee(tenantAId, branchAQaId);

      await postJson('/attendance/summary/run', tokenHrA, { workDate: friday, employeeId: usEmployee.id }).expect(201);
      await postJson('/attendance/summary/run', tokenHrA, { workDate: friday, employeeId: qaEmployee.id }).expect(201);

      const usSummary = await waitFor(async () => {
        const res = await get(`/attendance/reports/summary?employeeId=${usEmployee.id}&from=${friday}&to=${friday}`, tokenHrA).expect(200);
        return res.body[0] ?? null;
      });
      expect(usSummary.status).toBe('ABSENT');

      const qaSummary = await waitFor(async () => {
        const res = await get(`/attendance/reports/summary?employeeId=${qaEmployee.id}&from=${friday}&to=${friday}`, tokenHrA).expect(200);
        return res.body[0] ?? null;
      });
      expect(qaSummary.status).toBe('WEEKEND');
    });
  });

  describe('regularization runs through the real 0.7 workflow to the real 1.1 manager, and correctly applies overtime/day-attribution on approval', () => {
    let managerToken: string;
    let managerUserId: string;
    let subordinateEmployeeId: string;
    let subordinateUserId: string;

    beforeAll(async () => {
      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });

      const managerUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'attendance-manager@attendance-a.test');
      managerUserId = managerUser.id;
      managerToken = jwt.sign({ sub: managerUser.id, tenantId: tenantAId });
      const managerEmployee = await makeEmployee(tenantAId, branchAUsId, { userId: managerUser.id });

      const subordinateUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'attendance-subordinate@attendance-a.test');
      subordinateUserId = subordinateUser.id;
      const subordinateEmployee = await makeEmployee(tenantAId, branchAUsId, {
        userId: subordinateUser.id,
        managerId: managerEmployee.id,
      });
      subordinateEmployeeId = subordinateEmployee.id;
    });

    it('a missing-punch regularization, once approved by the real manager, creates the attendance record with correct overtime', async () => {
      const subordinateToken = jwt.sign({ sub: subordinateUserId, tenantId: tenantAId });

      // 2026-03-02 09:30 America/New_York (EST, UTC-5) -> 14:30 UTC; 18:00 -> 23:00 UTC. 8.5h worked, 30 min over the US pack's 8h daily threshold.
      const submitRes = await postJson('/attendance/regularizations', subordinateToken, {
        workDate: '2026-03-02',
        requestedClockInAt: '2026-03-02T14:30:00.000Z',
        requestedClockOutAt: '2026-03-02T23:00:00.000Z',
        reason: 'Forgot to clock in/out entirely that day.',
      }).expect(201);
      expect(submitRes.body.status).toBe('PENDING');
      expect(submitRes.body.employeeId).toBe(subordinateEmployeeId);
      const instanceId = submitRes.body.workflowInstanceId;

      const detailRes = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = detailRes.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(activeStep.eligibleApproverIds).toContain(managerUserId);

      await postJson(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'APPROVE' }).expect(201);

      const regularization = await waitFor(async () => {
        const res = await get(`/attendance/regularizations/${submitRes.body.id}`, subordinateToken).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });
      expect(regularization.attendanceRecordId).not.toBeNull();

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { id: regularization.attendanceRecordId } });
      expect(record.status).toBe('CLOSED');
      expect(record.workedMinutes).toBe(8.5 * 60);
      expect(record.overtimeMinutes).toBe(30);
      expect(record.workDate.toISOString().slice(0, 10)).toBe('2026-03-02');
      expect(record.clockInSource).toBe('MANUAL');
    });

    it('a rejected regularization leaves no attendance record behind', async () => {
      const subordinateToken = jwt.sign({ sub: subordinateUserId, tenantId: tenantAId });

      const submitRes = await postJson('/attendance/regularizations', subordinateToken, {
        workDate: '2026-03-09',
        requestedClockInAt: '2026-03-09T14:00:00.000Z',
        reason: 'Also forgot this day.',
      }).expect(201);
      const instanceId = submitRes.body.workflowInstanceId;

      const detailRes = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = detailRes.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await postJson(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, managerToken, { actionType: 'REJECT' }).expect(201);

      const regularization = await waitFor(async () => {
        const res = await get(`/attendance/regularizations/${submitRes.body.id}`, subordinateToken).expect(200);
        return res.body.status === 'REJECTED' ? res.body : null;
      });
      expect(regularization.attendanceRecordId).toBeNull();
    });
  });

  describe('the biometric device seam — a dev/manual concrete implementation', () => {
    it('translates a raw device punch into a real clock-in tagged with source BIOMETRIC', async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId, { employeeCode: 'BIO-1' });
      const res = await postJson('/attendance/devices/manual-punch', tokenHrA, {
        employeeCode: 'BIO-1',
        direction: 'IN',
        deviceId: 'test-device-1',
      }).expect(201);
      expect(res.body.employeeId).toBe(employee.id);
      expect(res.body.clockInSource).toBe('BIOMETRIC');
    });
  });

  describe('RBAC deny-by-default and branch scoping', () => {
    it('rejects a regularization submission without attendance.regularize', async () => {
      await postJson('/attendance/regularizations', tokenNoAttendancePermA, {
        workDate: '2026-05-01',
        requestedClockInAt: '2026-05-01T13:00:00.000Z',
        reason: 'x',
      }).expect(403);
    });

    it('a branch-restricted caller cannot view attendance records outside their allowed branch', async () => {
      const branchRestricted = await makeUserWithRole(
        tenantAId,
        (await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } })).id,
        'branch-restricted@attendance-a.test',
      );
      await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: branchRestricted.id, branchId: branchAUsId } });
      const restrictedToken = jwt.sign({ sub: branchRestricted.id, tenantId: tenantAId });

      const res = await get(`/attendance/records?branchId=${branchAQaId}`, restrictedToken).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot read tenant A's attendance record by id, and lists none of tenant A's records", async () => {
      const employee = await makeEmployee(tenantAId, branchAUsId);
      const record = await prisma.attendanceRecord.create({
        data: {
          tenantId: tenantAId,
          employeeId: employee.id,
          branchId: branchAUsId,
          workDate: new Date('2026-04-01'),
          clockInAt: new Date('2026-04-01T13:00:00.000Z'),
          clockInSource: 'WEB',
        },
      });

      await get(`/attendance/records/${record.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);

      const listRes = await get('/attendance/records', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listRes.body.some((r: { id: string }) => r.id === record.id)).toBe(false);
    });
  });

  describe('scale — partition-ready shape and tenantId-leading indexes', () => {
    it('has a composite (id, work_date) primary key, matching the audit_log partition-ready shape', async () => {
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = 'attendance_records' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position;
      `;
      expect(rows.map((r) => r.column_name)).toEqual(['id', 'work_date']);
    });

    it('every index on attendance_records leads with tenant_id (no unbounded cross-tenant scan is even expressible)', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE tablename = 'attendance_records';
      `;
      const nonPkIndexes = rows.filter((r) => !r.indexdef.includes('_pkey'));
      expect(nonPkIndexes.length).toBeGreaterThan(0);
      for (const row of nonPkIndexes) {
        expect(row.indexdef).toMatch(/\(tenant_id/);
      }
    });
  });
});
