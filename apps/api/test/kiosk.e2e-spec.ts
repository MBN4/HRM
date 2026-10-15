/**
 * Proves kiosk mode (step 11.1) end to end over real HTTP + Postgres + Redis — see
 * docs/conventions/kiosk.md: device registration/token handling, identify-and-clock producing a NORMAL
 * AttendanceRecord (source KIOSK) that flows through the real shift/status engine, the device trust model
 * (a kiosk token reaches ONLY the kiosk routes, ONLY for its own branch + tenant), PIN brute-force
 * protection, revocation, audit, RBAC on administration, and tenant isolation.
 *
 * A JWT is minted directly for the admin side, the same rationale every other e2e suite documents.
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
import {
  appPrisma,
  prisma,
  seedCountryPacks,
  seedSystemRolesAndPermissions,
  SYSTEM_ROLES,
  withTenantContext,
} from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { KioskTicketService } from '../src/kiosk/kiosk-ticket.service';
import { toBranchLocal } from '../src/attendance/attendance-timezone.util';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'kiosk-test-tenant-a';
const SLUG_B = 'kiosk-test-tenant-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });

const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;

describe('kiosk mode (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tickets: KioskTicketService;

  let tenantAId: string;
  let tenantBId: string;
  let branchA1Id: string; // the kiosk's branch (New York)
  let branchA2Id: string; // another branch of the same tenant
  let branchBId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  let kiosk: { id: string; token: string };

  let counter = 0;
  async function makeEmployee(
    tenantId: string,
    branchId: string,
    overrides: Record<string, unknown> = {},
  ) {
    counter += 1;
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `KT-${counter}`,
        firstName: 'Kay',
        lastName: `Tester${counter}`,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
        ...overrides,
      },
    });
  }

  async function makeUser(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({
      data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  const admin = {
    get: (path: string, token = tokenAdminA, slug = SLUG_A) =>
      request(app.getHttpServer())
        .get(path)
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, token = tokenAdminA, slug = SLUG_A) =>
      request(app.getHttpServer())
        .post(path)
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${token}`),
    patch: (path: string, token = tokenAdminA, slug = SLUG_A) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${token}`),
    del: (path: string, token = tokenAdminA, slug = SLUG_A) =>
      request(app.getHttpServer())
        .delete(path)
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${token}`),
  };

  /** A kiosk device call: NO Host header tenant, NO bearer — the device token alone. */
  const device = {
    get: (path: string, token: string) =>
      request(app.getHttpServer()).get(path).set('X-Kiosk-Token', token),
    post: (path: string, token: string) =>
      request(app.getHttpServer()).post(path).set('X-Kiosk-Token', token),
  };

  async function registerKiosk(body: Record<string, unknown>, as = tokenAdminA, slug = SLUG_A) {
    const res = await admin.post('/kiosks', as, slug).send(body).expect(201);
    return res.body as { id: string; token: string; branchId: string; name: string };
  }

  async function issuePin(employeeId: string): Promise<string> {
    const res = await admin.post(`/kiosks/pins/${employeeId}`).expect(201);
    return res.body.pin as string;
  }

  function identify(token: string, employeeCode: string, pin: string) {
    return device.post('/kiosk/identify', token).send({ employeeCode, pin });
  }

  function punch(token: string, ticket: string, action: 'IN' | 'OUT') {
    return device.post('/kiosk/clock', token).field('ticket', ticket).field('action', action);
  }

  /** identify + clock in one go; returns the clock response. */
  async function clockVia(token: string, employeeCode: string, pin: string, action: 'IN' | 'OUT') {
    const id = await identify(token, employeeCode, pin).expect(201);
    return punch(token, id.body.ticket, action);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tickets = moduleRef.get(KioskTicketService);

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: {
        name: 'Kiosk Test A',
        slug: SLUG_A,
        defaultCountryCode: 'US',
        hostingRegion: 'us-east-1',
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: 'Kiosk Test B',
        slug: SLUG_B,
        defaultCountryCode: 'US',
        hostingRegion: 'us-east-1',
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    branchA1Id = (
      await prisma.branch.create({
        data: {
          tenantId: tenantAId,
          name: 'Kiosk A1 HQ',
          countryCode: 'US',
          timezone: 'America/New_York',
        },
      })
    ).id;
    branchA2Id = (
      await prisma.branch.create({
        data: {
          tenantId: tenantAId,
          name: 'Kiosk A2 Annex',
          countryCode: 'US',
          timezone: 'America/New_York',
        },
      })
    ).id;
    branchBId = (
      await prisma.branch.create({
        data: {
          tenantId: tenantBId,
          name: 'Kiosk B HQ',
          countryCode: 'US',
          timezone: 'America/New_York',
        },
      })
    ).id;

    const role = (tenantId: string, name: string) =>
      prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } });
    const adminA = await makeUser(
      tenantAId,
      (await role(tenantAId, SYSTEM_ROLES.TENANT_ADMIN)).id,
      'admin@kiosk-a.test',
    );
    const hrA = await makeUser(
      tenantAId,
      (await role(tenantAId, SYSTEM_ROLES.HR_MANAGER)).id,
      'hr@kiosk-a.test',
    );
    const empA = await makeUser(
      tenantAId,
      (await role(tenantAId, SYSTEM_ROLES.EMPLOYEE)).id,
      'employee@kiosk-a.test',
    );
    const adminB = await makeUser(
      tenantBId,
      (await role(tenantBId, SYSTEM_ROLES.TENANT_ADMIN)).id,
      'admin@kiosk-b.test',
    );
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });
    tokenEmployeeA = jwt.sign({ sub: empA.id, tenantId: tenantAId });
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    kiosk = await registerKiosk({ name: 'A1 front desk', branchId: branchA1Id });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe('administration + RBAC', () => {
    it('registers a kiosk and returns the device token exactly once; only a hash is stored', async () => {
      expect(kiosk.token).toMatch(/^kio_[A-Za-z0-9_-]{43}$/);

      const row = await prisma.kiosk.findUniqueOrThrow({ where: { id: kiosk.id } });
      expect(row.branchId).toBe(branchA1Id);
      expect(row.hashedToken).toMatch(/^\$argon2id\$/);
      expect(row.hashedToken).not.toContain(kiosk.token);
      expect(row.tokenPrefix).toBe(kiosk.token.slice(0, 16));

      const list = await admin.get('/kiosks').expect(200);
      const listed = list.body.find((k: { id: string }) => k.id === kiosk.id);
      expect(listed.branchName).toBe('Kiosk A1 HQ');
      expect(JSON.stringify(list.body)).not.toContain(kiosk.token);
      expect(listed).not.toHaveProperty('hashedToken');
      expect(listed).not.toHaveProperty('token');
    });

    it('is audited without the raw token or PIN ever reaching audit_log', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      expect(pin).toMatch(/^\d{6}$/);

      const rows = await prisma.auditLog.findMany({
        where: { tenantId: tenantAId, entityType: { in: ['Kiosk', 'EmployeeKioskPin'] } },
      });
      const blob = JSON.stringify(rows);
      expect(rows.some((r) => r.action === 'REGISTER')).toBe(true);
      expect(rows.some((r) => r.action === 'ISSUE')).toBe(true);
      expect(blob).not.toContain(kiosk.token);
      expect(blob).not.toContain(`"pin":"${pin}"`);
      expect(blob).toContain('[REDACTED]');

      const stored = await prisma.employeeKioskPin.findFirstOrThrow({
        where: { employeeId: emp.id },
      });
      expect(stored.pinHash).toMatch(/^\$argon2id\$/);
      expect(stored.pinHash).not.toContain(pin);
    });

    it('allows only kiosk.manage (admin + HR) to register/list/rotate/revoke/issue PINs', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      await admin.get('/kiosks', tokenEmployeeA).expect(403);
      await admin
        .post('/kiosks', tokenEmployeeA)
        .send({ name: 'nope', branchId: branchA1Id })
        .expect(403);
      await admin.post(`/kiosks/${kiosk.id}/token`, tokenEmployeeA).expect(403);
      await admin.del(`/kiosks/${kiosk.id}`, tokenEmployeeA).expect(403);
      await admin.post(`/kiosks/pins/${emp.id}`, tokenEmployeeA).expect(403);
      await admin.get('/kiosks/pins', tokenEmployeeA).expect(403);
      // HR holds kiosk.manage.
      await admin.get('/kiosks', tokenHrA).expect(200);
      await admin.post(`/kiosks/pins/${emp.id}`, tokenHrA).expect(201);
    });

    it('rejects registering a kiosk for a branch that does not exist in the tenant, and bad bodies', async () => {
      await admin.post('/kiosks').send({ name: 'x', branchId: branchBId }).expect(404); // tenant B's branch
      await admin.post('/kiosks').send({ name: '', branchId: branchA1Id }).expect(400);
      await admin.post('/kiosks').send({ name: 'x', branchId: branchA1Id, evil: true }).expect(400);
    });

    it('lists employee PIN status without ever exposing a PIN or hash', async () => {
      const res = await admin.get('/kiosks/pins').query({ branchId: branchA1Id }).expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|pinHash|"pin"/);
      expect(res.body.some((r: { hasPin: boolean }) => r.hasPin)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('identify + clock → a normal AttendanceRecord (source KIOSK)', () => {
    let emp: { id: string; employeeCode: string };
    let pin: string;
    let shiftId: string;

    beforeAll(async () => {
      emp = await makeEmployee(tenantAId, branchA1Id);
      pin = await issuePin(emp.id);

      // A published roster cell for TODAY (branch-local) on an all-day shift starting 00:00 — so the
      // kiosk punch must be judged against this shift by the real 8.1/8.2 engine.
      const shift = await prisma.shiftDefinition.create({
        data: {
          tenantId: tenantAId,
          name: 'Kiosk all-day',
          startTime: '00:00',
          endTime: '23:59',
          breakMinutes: 0,
          graceMinutes: 15,
        },
      });
      shiftId = shift.id;
      const today = toBranchLocal(new Date(), 'America/New_York').calendarDate;
      await prisma.rosterAssignment.create({
        data: {
          tenantId: tenantAId,
          employeeId: emp.id,
          shiftDefinitionId: shift.id,
          effectiveFrom: today,
          effectiveTo: today,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
    });

    it('GET /kiosk/me describes the device (its own name + branch only)', async () => {
      const res = await device.get('/kiosk/me', kiosk.token).expect(200);
      expect(res.body).toEqual({
        id: kiosk.id,
        name: 'A1 front desk',
        branchId: branchA1Id,
        branchName: 'Kiosk A1 HQ',
        timezone: 'America/New_York',
        requirePhoto: false,
        biometricEnabled: false,
      });
    });

    it('identifies with employee code + PIN, returning the display name and today state — never salary/other data', async () => {
      const res = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      expect(res.body.employee).toEqual({
        employeeCode: emp.employeeCode,
        firstName: 'Kay',
        lastName: expect.stringMatching(/^Tester/),
      });
      expect(res.body.state.suggestedAction).toBe('IN');
      expect(res.body.state.openSince).toBeNull();
      expect(typeof res.body.ticket).toBe('string');
      expect(JSON.stringify(res.body)).not.toMatch(
        /salary|bank|statutory|personalEmail|dateOfBirth/i,
      );
    });

    it('clock-in creates the standard record: source KIOSK, kiosk stamped, shift resolved', async () => {
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      const res = await punch(kiosk.token, id.body.ticket, 'IN').expect(201);

      expect(res.body.action).toBe('IN');
      expect(res.body.record.clockInSource).toBe('KIOSK');
      expect(res.body.record.status).toBe('OPEN');
      expect(res.body.record.shiftDefinitionId).toBe(shiftId);
      expect(res.body.state.suggestedAction).toBe('OUT');
      expect(res.body.state.today.status).toBe('IN_PROGRESS');

      const row = await prisma.attendanceRecord.findFirstOrThrow({
        where: { id: res.body.record.id },
      });
      expect(row.clockInSource).toBe('KIOSK');
      expect(row.clockInKioskId).toBe(kiosk.id);
      expect(row.employeeId).toBe(emp.id);
      expect(row.branchId).toBe(branchA1Id);
    });

    it('a second clock-in is refused with a stable code', async () => {
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      expect(id.body.state.suggestedAction).toBe('OUT');
      const res = await punch(kiosk.token, id.body.ticket, 'IN').expect(400);
      expect(res.body.code).toBe('KIOSK_ALREADY_CLOCKED_IN');
    });

    it('clock-out closes the same record, computes metrics, and classification matches the real status engine', async () => {
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      const res = await punch(kiosk.token, id.body.ticket, 'OUT').expect(201);

      expect(res.body.record.status).toBe('CLOSED');
      expect(res.body.record.clockOutSource).toBe('KIOSK');
      expect(res.body.record.workedMinutes).toBeGreaterThanOrEqual(0);
      const row = await prisma.attendanceRecord.findFirstOrThrow({
        where: { id: res.body.record.id },
      });
      expect(row.clockOutKioskId).toBe(kiosk.id);

      // Judged against the roster shift (00:00 start) — i.e. the real shift-aware engine, not a kiosk rule.
      const today = res.body.state.today;
      expect(today.expectedStartTime).toBe('00:00');
      expect(today.status).toBe('RED');

      // …and it is exactly what the ordinary status endpoint says for the same day.
      const ymd = toBranchLocal(new Date(), 'America/New_York')
        .calendarDate.toISOString()
        .slice(0, 10);
      const normal = await admin
        .get('/attendance/status')
        .query({ employeeId: emp.id, from: ymd, to: ymd })
        .expect(200);
      expect(normal.body.days[0].status).toBe(today.status);
      expect(normal.body.days[0].reason).toBe(today.reason);
      expect(normal.body.days[0].expectedStartTime).toBe(today.expectedStartTime);

      // The punch is visible to ordinary attendance reads like any other record.
      const rec = await admin.get('/attendance/records').query({ employeeId: emp.id }).expect(200);
      expect(
        rec.body.some(
          (r: { id: string; clockInSource: string }) =>
            r.id === res.body.record.id && r.clockInSource === 'KIOSK',
        ),
      ).toBe(true);
    });

    it('clock-out with nothing open is refused with a stable code', async () => {
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      const res = await punch(kiosk.token, id.body.ticket, 'OUT').expect(400);
      expect(res.body.code).toBe('KIOSK_NOT_CLOCKED_IN');
    });

    it('audits each punch with the kiosk device AND the employee', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { tenantId: tenantAId, action: { in: ['KIOSK_CLOCK_IN', 'KIOSK_CLOCK_OUT'] } },
      });
      const mine = rows.filter(
        (r) => (r.metadata as { employeeId?: string } | null)?.employeeId === emp.id,
      );
      expect(mine.map((r) => r.action).sort()).toEqual(['KIOSK_CLOCK_IN', 'KIOSK_CLOCK_OUT']);
      for (const row of mine) {
        expect(row.actorUserId).toBeNull();
        expect(row.metadata).toMatchObject({
          kioskId: kiosk.id,
          kioskName: 'A1 front desk',
          branchId: branchA1Id,
          employeeCode: emp.employeeCode,
          method: 'PIN',
        });
      }
    });

    it("shows the device's recent activity to admins", async () => {
      const res = await admin.get(`/kiosks/${kiosk.id}/activity`).expect(200);
      expect(
        res.body.some((a: { employeeCode: string }) => a.employeeCode === emp.employeeCode),
      ).toBe(true);
      const list = await admin.get('/kiosks').expect(200);
      const me = list.body.find((k: { id: string }) => k.id === kiosk.id);
      expect(me.lastSeenAt).not.toBeNull();
      expect(me.online).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('PIN security', () => {
    it('rejects a wrong PIN and an unknown employee with the SAME response', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      await issuePin(emp.id);
      const wrong = await identify(kiosk.token, emp.employeeCode, '000000').expect(401);
      const unknown = await identify(kiosk.token, 'NO-SUCH-CODE', '000000').expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.code).toBe('KIOSK_INVALID_CREDENTIALS');
      // Malformed PINs never reach the verifier.
      await device
        .post('/kiosk/identify', kiosk.token)
        .send({ employeeCode: emp.employeeCode, pin: 'abcd' })
        .expect(400);
    });

    it('an employee with no PIN cannot identify', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      await identify(kiosk.token, emp.employeeCode, '123456').expect(401);
    });

    it('locks an employee after repeated wrong PINs — even the right PIN is then refused — until HR resets it', async () => {
      const k = await registerKiosk({ name: 'lockout kiosk', branchId: branchA1Id });
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      const wrongPin = pin === '999999' ? '999998' : '999999';

      for (let i = 0; i < 5; i += 1) {
        await identify(k.token, emp.employeeCode, wrongPin).expect(401);
      }
      const locked = await identify(k.token, emp.employeeCode, pin).expect(429);
      expect(locked.body.code).toBe('KIOSK_LOCKED');
      const status = await admin
        .get('/kiosks/pins')
        .query({ search: emp.employeeCode })
        .expect(200);
      expect(
        status.body.find((r: { employeeCode: string }) => r.employeeCode === emp.employeeCode)
          .locked,
      ).toBe(true);

      // The lockout follows the EMPLOYEE, not the device: another kiosk is refused too.
      const other = await registerKiosk({ name: 'other kiosk', branchId: branchA1Id });
      await identify(other.token, emp.employeeCode, pin).expect(429);

      // HR resetting the PIN unlocks.
      const newPin = await issuePin(emp.id);
      await identify(k.token, emp.employeeCode, newPin).expect(201);
      // …and the old PIN is dead.
      await identify(k.token, emp.employeeCode, pin === newPin ? '000001' : pin).expect(401);
    });

    it('rate-limits a device that is guessing across many employee codes', async () => {
      const k = await registerKiosk({ name: 'spray kiosk', branchId: branchA1Id });
      for (let i = 0; i < 20; i += 1) {
        await identify(k.token, `GUESS-${i}`, '123456').expect(401);
      }
      const res = await identify(k.token, 'GUESS-21', '123456').expect(429);
      expect(res.body.code).toBe('KIOSK_LOCKED');

      const failures = await prisma.auditLog.count({
        where: { tenantId: tenantAId, action: 'KIOSK_IDENTIFY_FAILED', entityId: k.id },
      });
      expect(failures).toBe(20); // failed attempts survive the rolled-back request transaction
    });

    it('a removed PIN stops working', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      await admin.del(`/kiosks/pins/${emp.id}`).expect(200);
      await identify(kiosk.token, emp.employeeCode, pin).expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the device trust model — what a kiosk token can and cannot do', () => {
    it('a kiosk token is refused on EVERY non-kiosk route, including ones it would otherwise look authorised for', async () => {
      const t = kiosk.token;
      await device.get('/employees', t).expect(403);
      await device.get('/employees/me', t).expect(403);
      await device.get('/attendance/records', t).expect(403);
      await device.get('/attendance/status', t).expect(403);
      await device.post('/attendance/clock-in', t).field('source', 'WEB').expect(403);
      await device.post('/attendance/devices/manual-punch', t).send({}).expect(403);
      await device.get('/kiosks', t).expect(403);
      await device.post('/kiosks', t).send({ name: 'x', branchId: branchA1Id }).expect(403);
      await device.post(`/kiosks/${kiosk.id}/token`, t).expect(403);
      await device.get('/kiosks/pins', t).expect(403);
      await device.get('/auth/me', t).expect(403);
      await device.get('/users', t).expect(403);
      await device.get('/payroll/runs', t).expect(403);
      await device.get('/notifications', t).expect(403);
    });

    it('a user JWT / no credential does not authenticate on kiosk routes', async () => {
      await request(app.getHttpServer())
        .get('/kiosk/me')
        .set('Host', hostFor(SLUG_A))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .expect(401);
      await request(app.getHttpServer()).get('/kiosk/me').expect(401);
      await request(app.getHttpServer())
        .post('/kiosk/identify')
        .send({ employeeCode: 'x', pin: '123456' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/kiosk/identify')
        .set('X-Api-Key', 'hrm_whatever')
        .send({ employeeCode: 'x', pin: '123456' })
        .expect(401);
      await device.get('/kiosk/me', 'kio_totally_made_up_token_value').expect(401);
      await device.get('/kiosk/me', kiosk.token.slice(0, 16)).expect(401); // the bare prefix is not the token
      await device.get('/kiosk/me', `${kiosk.token}x`).expect(401);
    });

    it('cannot clock an employee of ANOTHER BRANCH of the same tenant (even with the right PIN)', async () => {
      const other = await makeEmployee(tenantAId, branchA2Id);
      const pin = await issuePin(other.id);
      const res = await identify(kiosk.token, other.employeeCode, pin).expect(401);
      expect(res.body.code).toBe('KIOSK_INVALID_CREDENTIALS'); // indistinguishable from "wrong PIN"
      expect(await prisma.attendanceRecord.count({ where: { employeeId: other.id } })).toBe(0);

      // A kiosk registered AT that branch can.
      const annex = await registerKiosk({ name: 'A2 annex', branchId: branchA2Id });
      await clockVia(annex.token, other.employeeCode, pin, 'IN').then((r) =>
        expect(r.status).toBe(201),
      );
      // …and the A1 kiosk still can't clock them OUT.
      const open = await prisma.attendanceRecord.findFirstOrThrow({
        where: { employeeId: other.id, status: 'OPEN' },
      });
      await identify(kiosk.token, other.employeeCode, pin).expect(401);
      expect(
        (await prisma.attendanceRecord.findFirstOrThrow({ where: { id: open.id } })).status,
      ).toBe('OPEN');
    });

    it('cannot act for an employee of ANOTHER TENANT, even one sharing the same employee code', async () => {
      const sharedCode = 'SHARED-CODE-1';
      const mineA = await makeEmployee(tenantAId, branchA1Id, { employeeCode: sharedCode });
      const theirsB = await makeEmployee(tenantBId, branchBId, { employeeCode: sharedCode });
      const pinB = await prisma.employeeKioskPin.create({
        data: {
          tenantId: tenantBId,
          employeeId: theirsB.id,
          pinHash: (
            await prisma.employeeKioskPin.findFirstOrThrow({ where: { tenantId: tenantAId } })
          ).pinHash,
        },
      });
      expect(pinB.employeeId).toBe(theirsB.id);

      // Identify at A's kiosk resolves ONLY A's employee: A's (PIN-less) employee, not B's.
      await identify(kiosk.token, sharedCode, '123456').expect(401);
      expect(await prisma.attendanceRecord.count({ where: { employeeId: theirsB.id } })).toBe(0);
      expect(mineA.tenantId).toBe(tenantAId);
    });

    it('a ticket is bound to the device that minted it', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      const sibling = await registerKiosk({ name: 'sibling', branchId: branchA1Id });
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      const res = await punch(sibling.token, id.body.ticket, 'IN').expect(400);
      expect(res.body.code).toBe('KIOSK_TICKET_INVALID');
      expect(await prisma.attendanceRecord.count({ where: { employeeId: emp.id } })).toBe(0);
    });

    it('rejects tampered, forged-for-another-employee, and expired tickets', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const victim = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      const id = await identify(kiosk.token, emp.employeeCode, pin).expect(201);
      const [body, sig] = (id.body.ticket as string).split('.');

      // Swap the employee in the signed body → signature no longer matches.
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      claims.e = victim.id;
      const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
      expect((await punch(kiosk.token, forged, 'IN').expect(400)).body.code).toBe(
        'KIOSK_TICKET_INVALID',
      );
      expect(
        (await punch(kiosk.token, `${body}.${sig.slice(0, -2)}AA`, 'IN').expect(400)).body.code,
      ).toBe('KIOSK_TICKET_INVALID');
      expect((await punch(kiosk.token, 'a'.repeat(30), 'IN').expect(400)).body.code).toBe(
        'KIOSK_TICKET_INVALID',
      );

      // Properly signed but already expired.
      const realNow = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow - 5 * 60_000);
      const expired = tickets.sign({ t: tenantAId, k: kiosk.id, e: emp.id, m: 'PIN' }).ticket;
      spy.mockRestore();
      expect((await punch(kiosk.token, expired, 'IN').expect(400)).body.code).toBe(
        'KIOSK_TICKET_INVALID',
      );

      expect(
        await prisma.attendanceRecord.count({ where: { employeeId: { in: [emp.id, victim.id] } } }),
      ).toBe(0);
    });

    it('re-checks the employee at redemption: moved branches or terminated after identify → refused', async () => {
      const moved = await makeEmployee(tenantAId, branchA1Id);
      const left = await makeEmployee(tenantAId, branchA1Id);
      const pinMoved = await issuePin(moved.id);
      const pinLeft = await issuePin(left.id);
      const idMoved = await identify(kiosk.token, moved.employeeCode, pinMoved).expect(201);
      const idLeft = await identify(kiosk.token, left.employeeCode, pinLeft).expect(201);

      await prisma.employee.update({ where: { id: moved.id }, data: { branchId: branchA2Id } });
      await prisma.employee.update({ where: { id: left.id }, data: { status: 'TERMINATED' } });

      await punch(kiosk.token, idMoved.body.ticket, 'IN').expect(401);
      await punch(kiosk.token, idLeft.body.ticket, 'IN').expect(401);
      expect(
        await prisma.attendanceRecord.count({ where: { employeeId: { in: [moved.id, left.id] } } }),
      ).toBe(0);
    });

    it('a terminated employee cannot identify at all', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      await prisma.employee.update({ where: { id: emp.id }, data: { status: 'TERMINATED' } });
      await identify(kiosk.token, emp.employeeCode, pin).expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('device token lifecycle', () => {
    it('a revoked token is rejected immediately everywhere; rotating issues a new working token and kills the old', async () => {
      const k = await registerKiosk({ name: 'lifecycle', branchId: branchA1Id });
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);
      await device.get('/kiosk/me', k.token).expect(200);

      const revoked = await admin.del(`/kiosks/${k.id}`).expect(200);
      expect(revoked.body.status).toBe('REVOKED');
      await device.get('/kiosk/me', k.token).expect(401);
      await identify(k.token, emp.employeeCode, pin).expect(401);

      const rotated = await admin.post(`/kiosks/${k.id}/token`).expect(201);
      expect(rotated.body.status).toBe('ACTIVE');
      expect(rotated.body.token).not.toBe(k.token);
      await device.get('/kiosk/me', k.token).expect(401); // old token stays dead
      await device.get('/kiosk/me', rotated.body.token).expect(200);

      // Rotating a LIVE kiosk also kills the previous token at once.
      const rotatedAgain = await admin.post(`/kiosks/${k.id}/token`).expect(201);
      await device.get('/kiosk/me', rotated.body.token).expect(401);
      await device.get('/kiosk/me', rotatedAgain.body.token).expect(200);
    });

    it('a suspended tenant blocks its kiosks too', async () => {
      const k = await registerKiosk({ name: 'suspend', branchId: branchA1Id });
      await device.get('/kiosk/me', k.token).expect(200);
      await prisma.tenant.update({ where: { id: tenantAId }, data: { status: 'SUSPENDED' } });
      try {
        await device.get('/kiosk/me', k.token).expect(403);
      } finally {
        await prisma.tenant.update({ where: { id: tenantAId }, data: { status: 'ACTIVE' } });
      }
      await device.get('/kiosk/me', k.token).expect(200);
    });

    it('updates name/options (the branch is fixed)', async () => {
      const k = await registerKiosk({ name: 'before', branchId: branchA1Id });
      const res = await admin
        .patch(`/kiosks/${k.id}`)
        .send({ name: 'after', requirePhoto: true })
        .expect(200);
      expect(res.body).toMatchObject({ name: 'after', requirePhoto: true, branchId: branchA1Id });
      await admin.patch(`/kiosks/${k.id}`).send({ branchId: branchA2Id }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('photo capture (buddy-punching deterrent)', () => {
    it('refuses a punch without a photo when the kiosk requires one, accepts one with it, and rejects non-images', async () => {
      const k = await registerKiosk({
        name: 'photo kiosk',
        branchId: branchA1Id,
        requirePhoto: true,
      });
      const emp = await makeEmployee(tenantAId, branchA1Id);
      const pin = await issuePin(emp.id);

      const id = await identify(k.token, emp.employeeCode, pin).expect(201);
      expect(id.body.requirePhoto).toBe(true);
      expect((await punch(k.token, id.body.ticket, 'IN').expect(400)).body.code).toBe(
        'KIOSK_PHOTO_REQUIRED',
      );
      expect(
        (
          await punch(k.token, id.body.ticket, 'IN')
            .attach('photo', Buffer.from('<script>'), {
              filename: 'x.html',
              contentType: 'text/html',
            })
            .expect(400)
        ).body.code,
      ).toBe('KIOSK_PHOTO_INVALID');

      const ok = await punch(k.token, id.body.ticket, 'IN')
        .attach('photo', Buffer.from('fake-jpeg-bytes'), {
          filename: '../../evil name.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201);
      const row = await prisma.attendanceRecord.findFirstOrThrow({
        where: { id: ok.body.record.id },
      });
      expect(row.clockInPhotoKey).toContain(`attendance/${tenantAId}/${emp.id}/`);
      expect(row.clockInPhotoKey).not.toContain('..');
      expect(row.clockInPhotoKey).not.toContain(' ');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('biometric seam (opt-in per kiosk)', () => {
    it('is refused unless the kiosk opted in; when enabled it punches THROUGH the 1.3 seam (source BIOMETRIC) and stamps the kiosk', async () => {
      const emp = await makeEmployee(tenantAId, branchA1Id);
      await device
        .post('/kiosk/identify/biometric', kiosk.token)
        .send({ employeeCode: emp.employeeCode })
        .expect(403);

      const bio = await registerKiosk({
        name: 'bio kiosk',
        branchId: branchA1Id,
        biometricEnabled: true,
      });
      const id = await device
        .post('/kiosk/identify/biometric', bio.token)
        .send({ employeeCode: emp.employeeCode })
        .expect(201);
      const res = await punch(bio.token, id.body.ticket, 'IN').expect(201);
      expect(res.body.record.clockInSource).toBe('BIOMETRIC');
      const row = await prisma.attendanceRecord.findFirstOrThrow({
        where: { id: res.body.record.id },
      });
      expect(row.clockInKioskId).toBe(bio.id);

      // Still branch-fenced.
      const elsewhere = await makeEmployee(tenantAId, branchA2Id);
      await device
        .post('/kiosk/identify/biometric', bio.token)
        .send({ employeeCode: elsewhere.employeeCode })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it("another tenant's admin cannot see, edit, rotate, revoke or read activity of this tenant's kiosk", async () => {
      const mine = await admin.get('/kiosks', tokenAdminB, SLUG_B).expect(200);
      expect(mine.body.map((k: { id: string }) => k.id)).not.toContain(kiosk.id);
      await admin
        .patch(`/kiosks/${kiosk.id}`, tokenAdminB, SLUG_B)
        .send({ name: 'hijack' })
        .expect(404);
      await admin.post(`/kiosks/${kiosk.id}/token`, tokenAdminB, SLUG_B).expect(404);
      await admin.del(`/kiosks/${kiosk.id}`, tokenAdminB, SLUG_B).expect(404);
      await admin.get(`/kiosks/${kiosk.id}/activity`, tokenAdminB, SLUG_B).expect(404);
      // A's admin token against B's host is rejected outright.
      await admin.get('/kiosks', tokenAdminA, SLUG_B).expect(401);
    });

    it('RLS hides kiosks and PINs across tenants at the database layer', async () => {
      const asB = await withTenantContext(tenantBId, async (tx) => ({
        kiosks: await tx.kiosk.count({ where: { tenantId: tenantAId } }),
        pins: await tx.employeeKioskPin.count({ where: { tenantId: tenantAId } }),
        everyKioskIsB: (await tx.kiosk.findMany({ select: { tenantId: true } })).every(
          (k) => k.tenantId === tenantBId,
        ),
      }));
      expect(asB).toEqual({ kiosks: 0, pins: 0, everyKioskIsB: true });
      const asA = await withTenantContext(tenantAId, async (tx) => tx.kiosk.count());
      expect(asA).toBeGreaterThan(0);
    });

    it('a kiosk of tenant B (even with the same branch name) records only into tenant B', async () => {
      const kB = await registerKiosk({ name: 'B desk', branchId: branchBId }, tokenAdminB, SLUG_B);
      const empB = await makeEmployee(tenantBId, branchBId);
      const pin = await admin
        .post(`/kiosks/pins/${empB.id}`, tokenAdminB, SLUG_B)
        .expect(201)
        .then((r) => r.body.pin as string);
      const res = await clockVia(kB.token, empB.employeeCode, pin, 'IN');
      expect(res.status).toBe(201);
      const row = await prisma.attendanceRecord.findFirstOrThrow({
        where: { id: res.body.record.id },
      });
      expect(row.tenantId).toBe(tenantBId);
      // A's kiosk token is not valid for B's employee code, and A's admin cannot see B's activity.
      await identify(kiosk.token, empB.employeeCode, pin).expect(401);
      await admin.get(`/kiosks/${kB.id}/activity`).expect(404);
    });
  });
});
