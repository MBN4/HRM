/**
 * Proves step 8.2 (shift scheduling & rostering) end to end over real HTTP + Postgres:
 * named shifts (incl. an overnight one), standing team/member assignment with the same
 * precedence as the working-hours policy, the dated roster calendar overriding it (publish
 * semantics, day off, copy-week, coverage gaps), day-status classification judged against each
 * day's EFFECTIVE shift (incl. overnight + a rostered weekend), swap via the real workflow
 * engine, RBAC/hierarchy scope and cross-tenant isolation. See docs/conventions/shift-scheduling.md.
 *
 * New York in January is UTC-5 (09:00 local = 14:00Z).
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
import { ShiftResolutionService } from '../src/attendance/shifts/shift-resolution.service';
import { WorkingHoursResolverService } from '../src/working-hours/working-hours-resolver.service';
import { addDaysYmd } from '../src/scheduling/scheduling-day.util';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'sch-test-a';
const SLUG_B = 'sch-test-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;
const COMPANY = {
  startTime: '09:00',
  workHours: 8,
  breakHours: 1,
  graceMinutes: 15,
  halfDayThresholdHours: 4.5,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 8000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(100);
  }
}

describe('shift scheduling & rostering (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchUs: string;
  let branchQa: string;
  let deptMarketing: string;
  let deptSales: string;
  let deptSalesEast: string;
  let managerUserId: string;
  let n = 0;

  const shiftId: Record<'morning' | 'sales' | 'night', string> = {} as never;
  const emp: Record<string, { id: string; userId: string | null }> = {};
  const tokenOf: Record<string, string> = {};

  const req = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    slug: string,
    token: string,
    url: string,
    body?: unknown,
  ) => {
    const r = request(app.getHttpServer())
      [method](url)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? r : r.send(body as object);
  };
  const a = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    who: string,
    url: string,
    body?: unknown,
  ) => req(method, SLUG_A, tokenOf[who], url, body);

  async function makeUser(
    tenantId: string,
    email: string,
    role: string,
    managerId: string | null = null,
    branchId?: string,
  ) {
    const r = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: role } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE', managerId },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: r.id } });
    if (branchId) await prisma.userBranch.create({ data: { tenantId, userId: user.id, branchId } });
    tokenOf[email] = jwt.sign({ sub: user.id, tenantId });
    return user;
  }
  async function makeEmployee(
    key: string,
    tenantId: string,
    branchId: string,
    departmentId: string | null,
    userId: string | null,
  ) {
    n += 1;
    const e = await prisma.employee.create({
      data: {
        tenantId,
        branchId,
        departmentId,
        userId,
        employeeCode: `SC-${n}-${Date.now() % 100000}`,
        firstName: key,
        lastName: 'T',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });
    emp[key] = { id: e.id, userId };
    return e;
  }
  const rec = (e: { id: string }, workDate: string, inIso: string, outIso: string | null) =>
    prisma.attendanceRecord.create({
      data: {
        tenantId: tenantAId,
        employeeId: e.id,
        branchId: branchUs,
        workDate: new Date(`${workDate}T00:00:00Z`),
        clockInAt: new Date(inIso),
        clockInSource: 'WEB',
        clockOutAt: outIso ? new Date(outIso) : null,
        clockOutSource: outIso ? 'WEB' : null,
        status: outIso ? 'CLOSED' : 'OPEN',
      },
    });
  const effective = async (who: string, employeeKey: string, date: string) =>
    (
      await a(
        'get',
        who,
        `/working-hours/effective?employeeId=${emp[employeeKey].id}&date=${date}`,
      ).expect(200)
    ).body;
  const statusDays = async (who: string, employeeKey: string, from: string, to: string) => {
    const res = await a(
      'get',
      who,
      `/attendance/status?employeeId=${emp[employeeKey].id}&from=${from}&to=${to}`,
    ).expect(200);
    return {
      body: res.body,
      byDate: Object.fromEntries(res.body.days.map((d: { date: string }) => [d.date, d])) as Record<
        string,
        any
      >,
    };
  };
  const setCells = (who: string, cells: unknown[]) =>
    a('put', who, '/scheduling/roster/cells', { cells });
  const cell = (employeeKey: string, date: string, shift: string | null, dayOff = false) => ({
    employeeId: emp[employeeKey].id,
    date,
    shiftDefinitionId: shift,
    dayOff,
  });

  // Future dates (managers can't edit the past): the Monday ~2-3 weeks out, so week arithmetic is stable.
  const nextMonday = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7);
    return d.toISOString().slice(0, 10);
  })();
  const F = (offset: number) => addDaysYmd(nextMonday, offset);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);
    tenantAId = (
      await prisma.tenant.create({
        data: { name: 'SCH A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
      })
    ).id;
    tenantBId = (
      await prisma.tenant.create({
        data: { name: 'SCH B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
      })
    ).id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    branchUs = (
      await prisma.branch.create({
        data: { tenantId: tenantAId, name: 'US', countryCode: 'US', timezone: 'America/New_York' },
      })
    ).id;
    branchQa = (
      await prisma.branch.create({
        data: { tenantId: tenantAId, name: 'Doha', countryCode: 'QA', timezone: 'Asia/Qatar' },
      })
    ).id;
    const branchB = (
      await prisma.branch.create({
        data: { tenantId: tenantBId, name: 'B', countryCode: 'US', timezone: 'America/New_York' },
      })
    ).id;

    deptMarketing = (
      await prisma.department.create({
        data: { tenantId: tenantAId, branchId: branchUs, name: 'Marketing' },
      })
    ).id;
    deptSales = (
      await prisma.department.create({
        data: { tenantId: tenantAId, branchId: branchUs, name: 'Sales' },
      })
    ).id;
    deptSalesEast = (
      await prisma.department.create({
        data: {
          tenantId: tenantAId,
          branchId: branchUs,
          name: 'Sales East',
          parentDepartmentId: deptSales,
        },
      })
    ).id;

    await makeUser(tenantAId, 'hr@sch.test', SYSTEM_ROLES.HR_MANAGER);
    await makeUser(tenantAId, 'hrqa@sch.test', SYSTEM_ROLES.HR_MANAGER, null, branchQa);
    const mgr = await makeUser(tenantAId, 'mgr@sch.test', SYSTEM_ROLES.MANAGER);
    managerUserId = mgr.id;
    const repA = await makeUser(tenantAId, 'repa@sch.test', SYSTEM_ROLES.EMPLOYEE, mgr.id);
    const repB = await makeUser(tenantAId, 'repb@sch.test', SYSTEM_ROLES.EMPLOYEE, mgr.id);
    const outsider = await makeUser(tenantAId, 'outsider@sch.test', SYSTEM_ROLES.EMPLOYEE);
    const salesUser = await makeUser(tenantAId, 'sales1@sch.test', SYSTEM_ROLES.EMPLOYEE);
    const mktUser = await makeUser(tenantAId, 'mkt1@sch.test', SYSTEM_ROLES.EMPLOYEE);
    await makeUser(tenantBId, 'admin@schb.test', SYSTEM_ROLES.TENANT_ADMIN);

    await makeEmployee('mgr', tenantAId, branchUs, null, mgr.id);
    await makeEmployee('repA', tenantAId, branchUs, null, repA.id);
    await makeEmployee('repB', tenantAId, branchUs, null, repB.id);
    await makeEmployee('outsider', tenantAId, branchUs, null, outsider.id);
    await makeEmployee('sales1', tenantAId, branchUs, deptSales, salesUser.id);
    await makeEmployee('salesEast', tenantAId, branchUs, deptSalesEast, null);
    await makeEmployee('mkt1', tenantAId, branchUs, deptMarketing, mktUser.id);
    await makeEmployee('mkt2', tenantAId, branchUs, deptMarketing, null);
    await makeEmployee('ladder', tenantAId, branchUs, deptMarketing, null);
    await makeEmployee('plain', tenantAId, branchUs, null, null);
    await makeEmployee('qa1', tenantAId, branchQa, null, null);
    await prisma.employee.create({
      data: {
        tenantId: tenantBId,
        branchId: branchB,
        employeeCode: 'B-1',
        firstName: 'B',
        lastName: 'B',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });

    await a('put', 'hr@sch.test', '/working-hours/company', COMPANY).expect(200);

    // The workflow template a swap routes through (the real 0.7 engine; MANAGER rule = the requester's management chain).
    const tpl = await prisma.workflowTemplate.create({
      data: {
        tenantId: tenantAId,
        name: 'Shift Swap',
        entityType: 'ShiftSwap',
        version: 1,
        isActive: true,
      },
    });
    await prisma.workflowStep.create({
      data: {
        tenantId: tenantAId,
        templateId: tpl.id,
        name: 'Manager approval',
        order: 1,
        approverRule: { type: 'MANAGER' },
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  // =====================================================================
  describe('Part A — named shifts', () => {
    it('defines a day shift, an overnight shift and a night shift (HR)', async () => {
      const morning = await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Morning',
        startTime: '09:00',
        endTime: '17:00',
        breakMinutes: 60,
        graceMinutes: 15,
        color: '#1f8a70',
      }).expect(201);
      const sales = await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Sales Afternoon',
        startTime: '16:00',
        endTime: '01:00',
        breakMinutes: 60,
        graceMinutes: 15,
      }).expect(201);
      const night = await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Night',
        startTime: '22:00',
        endTime: '06:00',
        breakMinutes: 30,
        graceMinutes: 10,
        minStaffing: 1,
      }).expect(201);
      shiftId.morning = morning.body.id;
      shiftId.sales = sales.body.id;
      shiftId.night = night.body.id;
      expect(morning.body.crossesMidnight).toBe(false);
      expect(sales.body.crossesMidnight).toBe(true);
      expect(night.body.crossesMidnight).toBe(true);
    });

    it('lists shifts with the derived working-hours values and usage', async () => {
      const res = await a('get', 'hr@sch.test', '/scheduling/shifts').expect(200);
      const byName = Object.fromEntries(res.body.map((s: { name: string }) => [s.name, s]));
      // The shift maps 1:1 onto working-hours parameters: required = start->end (crossing midnight), work = required - break.
      expect(byName['Morning'].hours).toMatchObject({
        startTime: '09:00',
        requiredHours: 8,
        workHours: 7,
        breakHours: 1,
        graceMinutes: 15,
        halfDayThresholdHours: 4,
      });
      expect(byName['Sales Afternoon'].hours).toMatchObject({
        startTime: '16:00',
        requiredHours: 9,
        workHours: 8,
        breakHours: 1,
      });
      expect(byName['Night'].hours).toMatchObject({
        requiredHours: 8,
        workHours: 7.5,
        graceMinutes: 10,
      });
    });

    it('rejects nonsense and duplicates', async () => {
      await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Zero',
        startTime: '09:00',
        endTime: '09:00',
      }).expect(400);
      await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Long break',
        startTime: '09:00',
        endTime: '10:00',
        breakMinutes: 90,
      }).expect(400);
      await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Bad time',
        startTime: '9am',
        endTime: '17:00',
      }).expect(400);
      await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Morning',
        startTime: '08:00',
        endTime: '16:00',
      }).expect(409);
    });

    it('updates a shift (re-validated) and refuses to delete one that is in use', async () => {
      await a('patch', 'hr@sch.test', `/scheduling/shifts/${shiftId.morning}`, {
        color: '#112233',
        minStaffing: 2,
      }).expect(200);
      await a('patch', 'hr@sch.test', `/scheduling/shifts/${shiftId.morning}`, {
        breakMinutes: 600,
      }).expect(400);
      const spare = await a('post', 'hr@sch.test', '/scheduling/shifts', {
        name: 'Spare',
        startTime: '06:00',
        endTime: '14:00',
      }).expect(201);
      await a('delete', 'hr@sch.test', `/scheduling/shifts/${spare.body.id}`).expect(200);
      // (in-use deletion is asserted after standing assignments exist)
    });
  });

  // =====================================================================
  describe('Part A — standing assignment (team / member) + precedence', () => {
    it('Marketing -> Morning, Sales -> the 16:00-01:00 shift; the right shift resolves per team member', async () => {
      await a('put', 'hr@sch.test', `/scheduling/standing/teams/${deptMarketing}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(200);
      await a('put', 'hr@sch.test', `/scheduling/standing/teams/${deptSales}`, {
        shiftDefinitionId: shiftId.sales,
      }).expect(200);

      const mkt = await effective('hr@sch.test', 'mkt1', '2026-01-05');
      expect(mkt.source).toBe('TEAM');
      expect(mkt.shift).toMatchObject({ name: 'Morning', startTime: '09:00', endTime: '17:00' });
      expect(mkt.policy).toMatchObject({ startTime: '09:00', requiredHours: 8 });

      const sales = await effective('hr@sch.test', 'sales1', '2026-01-05');
      expect(sales.source).toBe('TEAM');
      expect(sales.shift).toMatchObject({ name: 'Sales Afternoon', crossesMidnight: true });
      expect(sales.policy).toMatchObject({ startTime: '16:00', requiredHours: 9, workHours: 8 });

      // A sub-department with no row of its own inherits its nearest ancestor's standing shift.
      const east = await effective('hr@sch.test', 'salesEast', '2026-01-05');
      expect(east).toMatchObject({ source: 'TEAM', sourceDepartmentId: deptSales });
      expect(east.shift.name).toBe('Sales Afternoon');

      // Someone on no team keeps the company default (custom hours, no shift).
      const plain = await effective('hr@sch.test', 'plain', '2026-01-05');
      expect(plain.source).toBe('COMPANY');
      expect(plain.shift).toBeNull();
      expect(plain.policy.requiredHours).toBe(9);
    });

    it('the shift and the policy never disagree: editing the shift changes everyone on it, live', async () => {
      await a('patch', 'hr@sch.test', `/scheduling/shifts/${shiftId.morning}`, {
        graceMinutes: 20,
      }).expect(200);
      expect((await effective('hr@sch.test', 'mkt1', '2026-01-05')).policy.graceMinutes).toBe(20);
      await a('patch', 'hr@sch.test', `/scheduling/shifts/${shiftId.morning}`, {
        graceMinutes: 15,
      }).expect(200);
    });

    it('proves the whole precedence ladder for one person: dated roster > member > team > company', async () => {
      const date = '2026-02-03';
      expect((await effective('hr@sch.test', 'ladder', date)).source).toBe('TEAM'); // Marketing -> Morning

      await a('put', 'hr@sch.test', `/scheduling/standing/members/${emp.ladder.id}`, {
        shiftDefinitionId: shiftId.night,
      }).expect(200);
      const member = await effective('hr@sch.test', 'ladder', date);
      expect(member).toMatchObject({ source: 'MEMBER' });
      expect(member.shift.name).toBe('Night'); // member beats team

      await setCells('hr@sch.test', [cell('ladder', date, shiftId.sales)]).expect(200);
      expect((await effective('hr@sch.test', 'ladder', date)).source).toBe('MEMBER'); // still a DRAFT -> not live
      await a('post', 'hr@sch.test', '/scheduling/roster/publish', { from: date, to: date }).expect(
        200,
      );
      const dated = await effective('hr@sch.test', 'ladder', date);
      expect(dated).toMatchObject({ source: 'ROSTER', rostered: true, dayOff: false });
      expect(dated.shift.name).toBe('Sales Afternoon'); // dated beats member
      expect((await effective('hr@sch.test', 'ladder', '2026-02-04')).source).toBe('MEMBER'); // only THAT date is overridden

      await setCells('hr@sch.test', [cell('ladder', date, null)]).expect(200); // clear the cell
      expect((await effective('hr@sch.test', 'ladder', date)).source).toBe('MEMBER');
      await a('delete', 'hr@sch.test', `/scheduling/standing/members/${emp.ladder.id}`).expect(200);
      expect((await effective('hr@sch.test', 'ladder', date)).source).toBe('TEAM');
      await a('delete', 'hr@sch.test', `/scheduling/standing/teams/${deptMarketing}`).expect(200);
      expect((await effective('hr@sch.test', 'ladder', date)).source).toBe('COMPANY');
      await a('put', 'hr@sch.test', `/scheduling/standing/teams/${deptMarketing}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(200);
    });

    it('custom working hours and a standing shift are one row, one meaning at a time', async () => {
      const custom = {
        startTime: '08:00',
        workHours: 8,
        breakHours: 1,
        graceMinutes: 5,
        halfDayThresholdHours: null,
      };
      await a('put', 'hr@sch.test', `/working-hours/members/${emp.mkt2.id}`, custom).expect(200);
      const e1 = await effective('hr@sch.test', 'mkt2', '2026-01-05');
      expect(e1).toMatchObject({ source: 'MEMBER', shift: null });
      expect(e1.policy.startTime).toBe('08:00');
      // A custom row is not a standing shift: the standing DELETE refuses it.
      await a('delete', 'hr@sch.test', `/scheduling/standing/members/${emp.mkt2.id}`).expect(409);
      // Setting a standing shift over it replaces the custom hours.
      await a('put', 'hr@sch.test', `/scheduling/standing/members/${emp.mkt2.id}`, {
        shiftDefinitionId: shiftId.night,
      }).expect(200);
      expect((await effective('hr@sch.test', 'mkt2', '2026-01-05')).shift.name).toBe('Night');
      // And the working-hours PUT converts it back (the link is cleared; the DB check forbids a mix).
      await a('put', 'hr@sch.test', `/working-hours/members/${emp.mkt2.id}`, custom).expect(200);
      const back = await effective('hr@sch.test', 'mkt2', '2026-01-05');
      expect(back.shift).toBeNull();
      expect(back.policy.startTime).toBe('08:00');
      await a('delete', 'hr@sch.test', `/working-hours/members/${emp.mkt2.id}`).expect(200);
      // The working-hours list shows a shift-linked team row with the shift's live hours.
      const list = (await a('get', 'hr@sch.test', '/working-hours/policies').expect(200)).body;
      const salesRow = list.find((p: { target?: { id: string } }) => p.target?.id === deptSales);
      expect(salesRow).toMatchObject({
        shift: { name: 'Sales Afternoon' },
        startTime: '16:00',
        requiredHours: 9,
      });
    });

    it('refuses to delete a shift that is still in use', async () => {
      await a('delete', 'hr@sch.test', `/scheduling/shifts/${shiftId.sales}`).expect(409);
    });

    it('standing assignment authority: HR sets team/company; a manager only sets members in their chain', async () => {
      await a('put', 'mgr@sch.test', `/scheduling/standing/teams/${deptSales}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(403);
      await a('put', 'mgr@sch.test', '/scheduling/standing/company', {
        shiftDefinitionId: shiftId.morning,
      }).expect(403);
      await a('put', 'mgr@sch.test', `/scheduling/standing/members/${emp.outsider.id}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(403);
      await a('put', 'mgr@sch.test', `/scheduling/standing/members/${emp.repA.id}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(200);
      expect((await effective('hr@sch.test', 'repA', '2026-01-05')).shift.name).toBe('Morning');
      await a('delete', 'mgr@sch.test', `/scheduling/standing/members/${emp.repA.id}`).expect(200);
      await a('put', 'repa@sch.test', `/scheduling/standing/members/${emp.repA.id}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(403);
    });
  });

  // =====================================================================
  describe('classification judges attendance against the day’s EFFECTIVE shift', () => {
    beforeAll(async () => {
      // mkt1: standing Morning 09:00-17:00 (8h required, grace 15) — NOT the company's 9h.
      await rec(emp.mkt1, '2026-01-05', '2026-01-05T14:05:00Z', '2026-01-05T22:10:00Z'); // 09:05-17:10  5 late, 8h05
      await rec(emp.mkt1, '2026-01-06', '2026-01-06T14:00:00Z', '2026-01-06T22:00:00Z'); // 09:00-17:00  exactly the shift (8h)
      // Thu 8th: a dated overnight roster cell (16:00-01:00), published.
      await rec(emp.mkt1, '2026-01-08', '2026-01-08T21:05:00Z', '2026-01-09T06:10:00Z'); // 16:05 -> 01:10 next day, 9h05
      // Sat 10th: a rostered WEEKEND night shift (22:00-06:00).
      await rec(emp.mkt1, '2026-01-10', '2026-01-11T03:00:00Z', '2026-01-11T11:00:00Z'); // 22:00 Sat -> 06:00 Sun, 8h
      // Tue 13th: a DRAFT night cell exists — it must NOT be used; the standing Morning shift still judges.
      await rec(emp.mkt1, '2026-01-13', '2026-01-13T14:00:00Z', '2026-01-13T22:00:00Z');
      // sales1: standing overnight 16:00-01:00 (9h required).
      await rec(emp.sales1, '2026-01-05', '2026-01-05T21:00:00Z', '2026-01-06T06:00:00Z'); // 16:00 -> 01:00, 9h  GREEN
      await rec(emp.sales1, '2026-01-06', '2026-01-06T21:30:00Z', '2026-01-07T06:30:00Z'); // 16:30 -> 01:30, 9h  late beyond grace

      await setCells('hr@sch.test', [
        cell('mkt1', '2026-01-07', null, true), // day off
        cell('mkt1', '2026-01-08', shiftId.sales),
        cell('mkt1', '2026-01-10', shiftId.night),
        cell('mkt1', '2026-01-12', shiftId.night),
      ]).expect(200);
      await a('post', 'hr@sch.test', '/scheduling/roster/publish', {
        from: '2026-01-05',
        to: '2026-01-12',
      }).expect(200);
      await setCells('hr@sch.test', [cell('mkt1', '2026-01-13', shiftId.night)]).expect(200); // stays DRAFT
      await rec(emp.mkt1, '2026-01-12', '2026-01-13T03:05:00Z', '2026-01-13T11:05:00Z'); // Mon 22:05 -> 06:05, 8h  (Night grace 10)
    });

    it('a standing shift sets the required hours / grace the day is judged by', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'mkt1', '2026-01-05', '2026-01-06');
      // 8h05 worked vs Morning's 8h required (the company policy would demand 9h and call this short).
      expect(byDate['2026-01-05']).toMatchObject({
        status: 'YELLOW',
        reason: 'WITHIN_GRACE',
        minutesLate: 5,
        requiredHours: 8,
        expectedStartTime: '09:00',
        policySource: 'TEAM',
      });
      expect(byDate['2026-01-05'].shift).toMatchObject({ name: 'Morning' });
      expect(byDate['2026-01-06']).toMatchObject({
        status: 'GREEN',
        reason: 'ON_TIME',
        requiredHours: 8,
      });
    });

    it('a standing OVERNIGHT shift: on time and late are judged across midnight', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'sales1', '2026-01-05', '2026-01-06');
      expect(byDate['2026-01-05']).toMatchObject({
        status: 'GREEN',
        reason: 'ON_TIME',
        requiredHours: 9,
        expectedStartTime: '16:00',
      });
      expect(byDate['2026-01-05'].hoursWorked).toBe(9);
      expect(byDate['2026-01-06']).toMatchObject({
        status: 'RED',
        reason: 'LATE_BEYOND_GRACE',
        minutesLate: 30,
      });
    });

    it('a dated roster cell overrides the standing shift for that date only', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'mkt1', '2026-01-07', '2026-01-09');
      // Thu the 8th: rostered onto 16:00-01:00 -> 16:05 in is 5 min late, 9h05 worked => YELLOW against THAT shift.
      expect(byDate['2026-01-08']).toMatchObject({
        status: 'YELLOW',
        reason: 'WITHIN_GRACE',
        minutesLate: 5,
        requiredHours: 9,
        expectedStartTime: '16:00',
        policySource: 'ROSTER',
      });
      expect(byDate['2026-01-08'].shift).toMatchObject({
        name: 'Sales Afternoon',
        crossesMidnight: true,
      });
      // Wed the 7th: a rostered DAY OFF.
      expect(byDate['2026-01-07']).toMatchObject({
        status: 'NEUTRAL',
        reason: 'DAY_OFF',
        policySource: 'ROSTER',
      });
      // Fri the 9th: back on the standing Morning shift, nothing recorded -> absent (the 01:10 clock-out above belongs to Thursday's shift).
      expect(byDate['2026-01-09']).toMatchObject({
        status: 'RED',
        reason: 'ABSENT',
        policySource: 'TEAM',
      });
    });

    it('a rostered weekend shift is a working day (not NEUTRAL weekend); an un-rostered Saturday still is', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'mkt1', '2026-01-10', '2026-01-17');
      expect(byDate['2026-01-10']).toMatchObject({
        status: 'GREEN',
        reason: 'ON_TIME',
        requiredHours: 8,
        expectedStartTime: '22:00',
      });
      expect(byDate['2026-01-17']).toMatchObject({ status: 'NEUTRAL', reason: 'WEEKEND' });
    });

    it('an overnight NIGHT shift rostered on a weekday is judged against 22:00, with its own grace', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'mkt1', '2026-01-12', '2026-01-12');
      expect(byDate['2026-01-12']).toMatchObject({
        status: 'YELLOW',
        reason: 'WITHIN_GRACE',
        minutesLate: 5,
        requiredHours: 8,
        expectedStartTime: '22:00',
        graceMinutes: 10,
      });
    });

    it('an unpublished (DRAFT) cell is ignored by classification', async () => {
      const { byDate } = await statusDays('hr@sch.test', 'mkt1', '2026-01-13', '2026-01-13');
      expect(byDate['2026-01-13']).toMatchObject({
        status: 'GREEN',
        requiredHours: 8,
        expectedStartTime: '09:00',
        policySource: 'TEAM',
      });
    });

    it('a 90-day range classifies in one call (roster + standing resolved once, not per day)', async () => {
      const res = await a(
        'get',
        'hr@sch.test',
        `/attendance/status?employeeId=${emp.mkt1.id}&from=2026-01-01&to=2026-03-31`,
      ).expect(200);
      expect(res.body.days).toHaveLength(90);
    });

    it('clock-in resolves the STANDING shift and snapshots it on the record; post-midnight clock-ins attribute to the start day', async () => {
      const inRes = await request(app.getHttpServer())
        .post('/attendance/clock-in')
        .set('Host', hostFor(SLUG_A))
        .set('Authorization', `Bearer ${tokenOf['sales1@sch.test']}`)
        .field('source', 'WEB')
        .expect(201);
      expect(inRes.body.shiftDefinitionId).toBe(shiftId.sales);

      const svc = new ShiftResolutionService(new WorkingHoursResolverService());
      const at = async (iso: string) =>
        withTenantContext(tenantAId, (tx) =>
          svc.resolveForClockIn(tx, emp.sales1.id, new Date(iso), 'America/New_York'),
        );
      // Tue 00:30 New York (05:30Z) is the tail of Monday's 16:00-01:00 shift?  01:00 end -> yes: attributed to MONDAY.
      const tail = await at('2026-01-20T05:30:00Z');
      expect(tail.workDate.toISOString().slice(0, 10)).toBe('2026-01-19');
      expect(tail.shift?.id).toBe(shiftId.sales);
      // 02:30 New York is after that shift ended: a new day.
      const later = await at('2026-01-20T07:30:00Z');
      expect(later.workDate.toISOString().slice(0, 10)).toBe('2026-01-20');
    });
  });

  // =====================================================================
  describe('Part B — rostering calendar: draft, publish, "my schedule", change notices, copy, coverage', () => {
    it('a manager rosters their reports (as a draft); the employee sees nothing until it is published', async () => {
      const res = await setCells('mgr@sch.test', [
        cell('repA', F(0), shiftId.morning),
        cell('repA', F(1), shiftId.night),
        cell('repA', F(2), null, true),
        cell('repB', F(0), shiftId.sales),
      ]).expect(200);
      expect(res.body).toMatchObject({ created: 4 });

      const before = (
        await a('get', 'repa@sch.test', `/scheduling/my-schedule?from=${F(0)}&to=${F(4)}`).expect(
          200,
        )
      ).body;
      expect(before.days.every((d: { via: string | null }) => d.via !== 'ROSTER')).toBe(true);
    });

    it('publish makes it live: the employee sees their upcoming shifts and gets a notification', async () => {
      const pub = await a('post', 'mgr@sch.test', '/scheduling/roster/publish', {
        from: F(0),
        to: F(6),
      }).expect(200);
      expect(pub.body).toMatchObject({ published: 4, employees: 2 });

      const mine = (
        await a('get', 'repa@sch.test', `/scheduling/my-schedule?from=${F(0)}&to=${F(4)}`).expect(
          200,
        )
      ).body;
      const day = Object.fromEntries(mine.days.map((d: { date: string }) => [d.date, d]));
      expect(day[F(0)]).toMatchObject({ kind: 'SHIFT', via: 'ROSTER', startTime: '09:00' });
      expect(day[F(0)].shift.name).toBe('Morning');
      expect(day[F(1)].shift).toMatchObject({ name: 'Night', crossesMidnight: true });
      expect(day[F(2)]).toMatchObject({ kind: 'DAY_OFF' });

      const note = await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            tenantId: tenantAId,
            recipientUserId: emp.repA.userId as string,
            eventType: 'roster.published',
          },
        }),
      );
      expect(note.payload).toMatchObject({ days: 3 });
    });

    it('a change AFTER publish is live immediately and the employee is notified', async () => {
      const res = await setCells('mgr@sch.test', [cell('repA', F(0), shiftId.night)]).expect(200);
      expect(res.body).toMatchObject({ updated: 1, changeNotices: 1 });
      const mine = (
        await a('get', 'repa@sch.test', `/scheduling/my-schedule?from=${F(0)}&to=${F(0)}`).expect(
          200,
        )
      ).body;
      expect(mine.days[0].shift.name).toBe('Night');
      const note = await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            tenantId: tenantAId,
            recipientUserId: emp.repA.userId as string,
            eventType: 'roster.changed',
          },
        }),
      );
      expect(note.payload).toMatchObject({
        date: F(0),
        previousShift: 'Morning',
        shiftName: 'Night',
      });
    });

    it('"copy last week" repeats the cells onto the next week as drafts (rotations)', async () => {
      const res = await a('post', 'mgr@sch.test', '/scheduling/roster/copy', {
        sourceFrom: F(0),
        sourceTo: F(6),
        targetFrom: F(7),
      }).expect(201);
      expect(res.body).toMatchObject({ copied: 4, created: 4 });
      const grid = (
        await a('get', 'mgr@sch.test', `/scheduling/roster?from=${F(7)}&to=${F(13)}`).expect(200)
      ).body;
      const copied = grid.cells.filter((c: { date: string }) => c.date >= F(7));
      expect(copied).toHaveLength(4);
      expect(copied.every((c: { status: string }) => c.status === 'DRAFT')).toBe(true);
    });

    it('the roster grid is one call per window: employees + standing + cells + leave', async () => {
      const grid = (
        await a('get', 'hr@sch.test', `/scheduling/roster?from=${F(0)}&to=${F(13)}`).expect(200)
      ).body;
      expect(grid.days).toHaveLength(14);
      expect(grid.canDefineShifts).toBe(true);
      const salesRow = grid.employees.find((e: { id: string }) => e.id === emp.sales1.id);
      expect(salesRow.standing).toMatchObject({ source: 'TEAM', shiftId: shiftId.sales });
      expect(grid.shifts.map((s: { name: string }) => s.name)).toEqual(
        expect.arrayContaining(['Morning', 'Sales Afternoon', 'Night']),
      );
      expect(Object.keys(grid.branches)).toEqual(expect.arrayContaining([branchUs, branchQa]));
      // A window beyond 42 days is refused.
      await a('get', 'hr@sch.test', `/scheduling/roster?from=${F(0)}&to=${F(60)}`).expect(400);
    });

    it('coverage lists who is on which shift per day and flags gaps against the shift’s min staffing', async () => {
      const cov = (
        await a('get', 'hr@sch.test', `/scheduling/coverage?from=${F(0)}&to=${F(6)}`).expect(200)
      ).body;
      const day1 = cov.days.find((d: { date: string }) => d.date === F(1)); // Tue: repA on Night
      const night = day1.shifts.find((s: { shiftId: string }) => s.shiftId === shiftId.night);
      expect(night).toMatchObject({ count: 1, minStaffing: 1, gap: false });
      const day2 = cov.days.find((d: { date: string }) => d.date === F(2)); // Wed: nobody on Night -> a gap
      expect(
        day2.shifts.find((s: { shiftId: string }) => s.shiftId === shiftId.night),
      ).toMatchObject({ count: 0, gap: true });
      expect(
        cov.gaps.some(
          (g: { date: string; shiftId: string }) => g.date === F(2) && g.shiftId === shiftId.night,
        ),
      ).toBe(true);
      const dayOffToday = day2.off;
      expect(dayOffToday).toBeGreaterThanOrEqual(1); // repA's day off
    });

    it('a manager cannot edit the past; HR can correct it', async () => {
      await setCells('mgr@sch.test', [cell('repA', '2020-01-01', shiftId.morning)]).expect(400);
      await setCells('hr@sch.test', [cell('repA', '2020-01-01', shiftId.morning)]).expect(200);
      await setCells('hr@sch.test', [cell('repA', '2020-01-01', null)]).expect(200);
    });
  });

  // =====================================================================
  describe('Part B — shift swap through the real workflow engine', () => {
    let swapId: string;
    const SWAP_DAY = () => F(3);

    beforeAll(async () => {
      await setCells('mgr@sch.test', [cell('repA', SWAP_DAY(), shiftId.morning)]).expect(200);
      await a('post', 'mgr@sch.test', '/scheduling/roster/publish', {
        from: SWAP_DAY(),
        to: SWAP_DAY(),
      }).expect(200);
    });

    it('guards: needs a shift to hand off, not yourself, not the past, no duplicates', async () => {
      await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: F(5),
        counterpartEmployeeId: emp.repB.id,
      }).expect(400); // no shift that day (a weekend)
      await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: SWAP_DAY(),
        counterpartEmployeeId: emp.repA.id,
      }).expect(400);
      await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: '2020-01-01',
        counterpartEmployeeId: emp.repB.id,
      }).expect(400);
      await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: SWAP_DAY(),
        counterpartEmployeeId: emp.qa1.id,
      }).expect(400); // different branch + no login
    });

    it('request -> colleague accepts -> the manager approves via the workflow -> both rosters update', async () => {
      const created = await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: SWAP_DAY(),
        counterpartEmployeeId: emp.repB.id,
        reason: 'Dentist',
      }).expect(201);
      swapId = created.body.id;
      expect(created.body).toMatchObject({
        status: 'AWAITING_PEER',
        requesterShift: { name: 'Morning' },
        counterpartShift: null,
      });
      await a('post', 'repa@sch.test', '/scheduling/swaps', {
        date: SWAP_DAY(),
        counterpartEmployeeId: emp.repB.id,
      }).expect(409);

      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            tenantId: tenantAId,
            recipientUserId: emp.repB.userId as string,
            eventType: 'shift_swap.requested',
          },
        }),
      );
      // Only the colleague can answer.
      await a('post', 'outsider@sch.test', `/scheduling/swaps/${swapId}/respond`, {
        accept: true,
      }).expect(404);
      await a('post', 'repa@sch.test', `/scheduling/swaps/${swapId}/respond`, {
        accept: true,
      }).expect(404);

      const accepted = await a('post', 'repb@sch.test', `/scheduling/swaps/${swapId}/respond`, {
        accept: true,
      }).expect(200);
      expect(accepted.body.status).toBe('PENDING_APPROVAL');
      const instanceId = accepted.body.workflowInstanceId as string;
      expect(instanceId).toBeTruthy();

      // Not applied yet: the approval is still pending.
      expect(
        (
          await a(
            'get',
            'repb@sch.test',
            `/scheduling/my-schedule?from=${SWAP_DAY()}&to=${SWAP_DAY()}`,
          ).expect(200)
        ).body.days[0].kind,
      ).not.toBe('SHIFT');

      const detail = await a('get', 'mgr@sch.test', `/workflow/instances/${instanceId}`).expect(
        200,
      );
      expect(detail.body.instance.entityType).toBe('ShiftSwap');
      const step = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(step.eligibleApproverIds).toContain(managerUserId);
      await a(
        'post',
        'mgr@sch.test',
        `/workflow/instances/${instanceId}/steps/${step.id}/actions`,
        { actionType: 'APPROVE' },
      ).expect(201);

      await waitFor(
        async () =>
          (await prisma.shiftSwapRequest.findUnique({ where: { id: swapId } }))?.status ===
          'APPROVED',
      );
      const theirs = (
        await a(
          'get',
          'repb@sch.test',
          `/scheduling/my-schedule?from=${SWAP_DAY()}&to=${SWAP_DAY()}`,
        ).expect(200)
      ).body.days[0];
      expect(theirs).toMatchObject({ kind: 'SHIFT', via: 'ROSTER' });
      expect(theirs.shift.name).toBe('Morning');
      const mine = (
        await a(
          'get',
          'repa@sch.test',
          `/scheduling/my-schedule?from=${SWAP_DAY()}&to=${SWAP_DAY()}`,
        ).expect(200)
      ).body.days[0];
      expect(mine.kind).toBe('DAY_OFF'); // handed off to someone who had no shift: A is relieved
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            tenantId: tenantAId,
            recipientUserId: emp.repB.userId as string,
            eventType: 'roster.changed',
          },
        }),
      );
    });

    it('a decline, a rejection and a stale swap leave the roster untouched', async () => {
      // Decline.
      await setCells('mgr@sch.test', [cell('repA', F(8), shiftId.morning)]).expect(200);
      await a('post', 'mgr@sch.test', '/scheduling/roster/publish', {
        from: F(8),
        to: F(8),
      }).expect(200);
      const s1 = (
        await a('post', 'repa@sch.test', '/scheduling/swaps', {
          date: F(8),
          counterpartEmployeeId: emp.repB.id,
        }).expect(201)
      ).body;
      expect(
        (
          await a('post', 'repb@sch.test', `/scheduling/swaps/${s1.id}/respond`, {
            accept: false,
          }).expect(200)
        ).body.status,
      ).toBe('DECLINED');

      // Reject through the workflow.
      const s2 = (
        await a('post', 'repa@sch.test', '/scheduling/swaps', {
          date: F(8),
          counterpartEmployeeId: emp.repB.id,
        }).expect(201)
      ).body;
      const acc = (
        await a('post', 'repb@sch.test', `/scheduling/swaps/${s2.id}/respond`, {
          accept: true,
        }).expect(200)
      ).body;
      const det = await a(
        'get',
        'mgr@sch.test',
        `/workflow/instances/${acc.workflowInstanceId}`,
      ).expect(200);
      const step = det.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await a(
        'post',
        'mgr@sch.test',
        `/workflow/instances/${acc.workflowInstanceId}/steps/${step.id}/actions`,
        { actionType: 'REJECT' },
      ).expect(201);
      await waitFor(
        async () =>
          (await prisma.shiftSwapRequest.findUnique({ where: { id: s2.id } }))?.status ===
          'REJECTED',
      );
      expect(
        (
          await a('get', 'repa@sch.test', `/scheduling/my-schedule?from=${F(8)}&to=${F(8)}`).expect(
            200,
          )
        ).body.days[0].shift.name,
      ).toBe('Morning');

      // Stale: the manager changes A's shift while the swap awaits approval -> canceled, not applied over the new roster.
      const s3 = (
        await a('post', 'repa@sch.test', '/scheduling/swaps', {
          date: F(8),
          counterpartEmployeeId: emp.repB.id,
        }).expect(201)
      ).body;
      const acc3 = (
        await a('post', 'repb@sch.test', `/scheduling/swaps/${s3.id}/respond`, {
          accept: true,
        }).expect(200)
      ).body;
      await setCells('mgr@sch.test', [cell('repA', F(8), shiftId.night)]).expect(200);
      const det3 = await a(
        'get',
        'mgr@sch.test',
        `/workflow/instances/${acc3.workflowInstanceId}`,
      ).expect(200);
      const step3 = det3.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await a(
        'post',
        'mgr@sch.test',
        `/workflow/instances/${acc3.workflowInstanceId}/steps/${step3.id}/actions`,
        { actionType: 'APPROVE' },
      ).expect(201);
      const stale = await waitFor(async () => {
        const r = await prisma.shiftSwapRequest.findUnique({ where: { id: s3.id } });
        return r && r.status !== 'PENDING_APPROVAL' ? r : null;
      });
      expect(stale).toMatchObject({ status: 'CANCELED', decisionNote: 'ROSTER_CHANGED' });
      expect(
        (
          await a('get', 'repa@sch.test', `/scheduling/my-schedule?from=${F(8)}&to=${F(8)}`).expect(
            200,
          )
        ).body.days[0].shift.name,
      ).toBe('Night');
    });

    it('the requester can withdraw; swaps are listed for the parties and (scoped) the manager', async () => {
      await setCells('mgr@sch.test', [cell('repA', F(9), shiftId.morning)]).expect(200);
      await a('post', 'mgr@sch.test', '/scheduling/roster/publish', {
        from: F(9),
        to: F(9),
      }).expect(200);
      const s = (
        await a('post', 'repa@sch.test', '/scheduling/swaps', {
          date: F(9),
          counterpartEmployeeId: emp.repB.id,
        }).expect(201)
      ).body;
      expect(
        (await a('post', 'repa@sch.test', `/scheduling/swaps/${s.id}/cancel`).expect(200)).body
          .status,
      ).toBe('CANCELED');
      await a('post', 'repb@sch.test', `/scheduling/swaps/${s.id}/cancel`).expect(404);

      const mineA = (await a('get', 'repa@sch.test', '/scheduling/swaps').expect(200)).body;
      const mineB = (await a('get', 'repb@sch.test', '/scheduling/swaps').expect(200)).body;
      expect(mineA.length).toBeGreaterThanOrEqual(4);
      expect(mineB.some((x: { id: string }) => x.id === swapId)).toBe(true);
      expect(
        (await a('get', 'outsider@sch.test', '/scheduling/swaps').expect(200)).body,
      ).toHaveLength(0);
      const team = (await a('get', 'mgr@sch.test', '/scheduling/swaps?scope=team').expect(200))
        .body;
      expect(team.some((x: { id: string }) => x.id === swapId)).toBe(true);
      await a('get', 'repa@sch.test', '/scheduling/swaps?scope=team').expect(403);
    });
  });

  // =====================================================================
  describe('RBAC, hierarchy scope and tenant isolation', () => {
    it('a manager schedules only people in their reporting chain', async () => {
      await setCells('mgr@sch.test', [cell('outsider', F(0), shiftId.morning)]).expect(403);
      await setCells('mgr@sch.test', [
        cell('repA', F(10), shiftId.morning),
        cell('outsider', F(10), shiftId.morning),
      ]).expect(403); // all-or-nothing
      expect(
        (
          await a('get', 'hr@sch.test', `/scheduling/roster?from=${F(10)}&to=${F(10)}`).expect(200)
        ).body.cells.filter((c: { date: string }) => c.date === F(10)),
      ).toHaveLength(0);
      await a('post', 'mgr@sch.test', '/scheduling/roster/copy', {
        sourceFrom: F(0),
        sourceTo: F(6),
        targetFrom: F(14),
        employeeIds: [emp.outsider.id],
      }).expect(201); // narrowed to nobody they own -> no-op
    });

    it('the manager’s grid and people list contain only their reports (HR sees everyone)', async () => {
      const grid = (
        await a('get', 'mgr@sch.test', `/scheduling/roster?from=${F(0)}&to=${F(6)}`).expect(200)
      ).body;
      const ids = grid.employees.map((e: { id: string }) => e.id).sort();
      expect(ids).toEqual([emp.repA.id, emp.repB.id].sort());
      expect(grid.canDefineShifts).toBe(false);
      const hrGrid = (
        await a('get', 'hr@sch.test', `/scheduling/roster?from=${F(0)}&to=${F(6)}`).expect(200)
      ).body;
      expect(hrGrid.employees.length).toBeGreaterThan(8);
      const people = (await a('get', 'mgr@sch.test', '/scheduling/people').expect(200)).body;
      expect(people.tenantWide).toBe(false);
      expect(people.employees).toHaveLength(2);
    });

    it('a plain member cannot roster, publish, define shifts or read the grid', async () => {
      await setCells('repa@sch.test', [cell('repA', F(10), shiftId.morning)]).expect(403);
      await a('post', 'repa@sch.test', '/scheduling/roster/publish', {
        from: F(0),
        to: F(6),
      }).expect(403);
      await a('post', 'repa@sch.test', '/scheduling/shifts', {
        name: 'Mine',
        startTime: '09:00',
        endTime: '17:00',
      }).expect(403);
      await a('get', 'repa@sch.test', `/scheduling/roster?from=${F(0)}&to=${F(6)}`).expect(403);
      await a('get', 'repa@sch.test', `/scheduling/coverage?from=${F(0)}&to=${F(6)}`).expect(403);
    });

    it('a manager can roster but cannot define/edit/delete shifts (tenant-wide authority)', async () => {
      await a('post', 'mgr@sch.test', '/scheduling/shifts', {
        name: 'Mgr shift',
        startTime: '09:00',
        endTime: '17:00',
      }).expect(403);
      await a('patch', 'mgr@sch.test', `/scheduling/shifts/${shiftId.morning}`, {
        color: '#000000',
      }).expect(403);
      await a('delete', 'mgr@sch.test', `/scheduling/shifts/${shiftId.morning}`).expect(403);
    });

    it('the legacy attendance routes no longer let any employee define shifts or range-assign rosters', async () => {
      await a('post', 'repa@sch.test', '/attendance/shifts', {
        name: 'Sneaky',
        startTime: '09:00',
        endTime: '17:00',
      }).expect(403);
      await a('post', 'repa@sch.test', '/attendance/rosters', {
        employeeId: emp.repA.id,
        shiftDefinitionId: shiftId.morning,
        effectiveFrom: F(0),
      }).expect(403);
      await a('post', 'mgr@sch.test', '/attendance/rosters', {
        employeeId: emp.repA.id,
        shiftDefinitionId: shiftId.morning,
        effectiveFrom: F(0),
      }).expect(403); // tenant-wide only
      await a('get', 'repa@sch.test', `/attendance/rosters?employeeId=${emp.outsider.id}`).expect(
        403,
      ); // someone else's roster
      await a('get', 'repa@sch.test', `/attendance/rosters?employeeId=${emp.repA.id}`).expect(200); // your own
      // HR can still create a legacy multi-day range (published), and a one-day cell outranks it for that date.
      await a('post', 'hr@sch.test', '/attendance/rosters', {
        employeeId: emp.plain.id,
        shiftDefinitionId: shiftId.night,
        effectiveFrom: '2026-03-02',
        effectiveTo: '2026-03-06',
      }).expect(201);
      await setCells('hr@sch.test', [cell('plain', '2026-03-04', shiftId.morning)]).expect(200);
      await a('post', 'hr@sch.test', '/scheduling/roster/publish', {
        from: '2026-03-04',
        to: '2026-03-04',
      }).expect(200);
      expect((await effective('hr@sch.test', 'plain', '2026-03-03')).shift.name).toBe('Night');
      expect((await effective('hr@sch.test', 'plain', '2026-03-04')).shift.name).toBe('Morning'); // narrowest span wins
      expect((await effective('hr@sch.test', 'plain', '2026-03-05')).shift.name).toBe('Night');
    });

    it('a branch-restricted scheduler cannot touch another branch (404, never a hint)', async () => {
      await setCells('hrqa@sch.test', [cell('mkt1', F(10), shiftId.morning)]).expect(404);
      await setCells('hrqa@sch.test', [cell('qa1', F(10), shiftId.morning)]).expect(200);
      const grid = (
        await a('get', 'hrqa@sch.test', `/scheduling/roster?from=${F(10)}&to=${F(10)}`).expect(200)
      ).body;
      expect(grid.employees.map((e: { id: string }) => e.id)).toEqual([emp.qa1.id]);
      await a('put', 'hrqa@sch.test', `/scheduling/standing/teams/${deptSales}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(404);
    });

    it('another tenant sees none of this and cannot reach it', async () => {
      const tb = tokenOf['admin@schb.test'];
      const grid = (
        await req('get', SLUG_B, tb, `/scheduling/roster?from=${F(0)}&to=${F(6)}`).expect(200)
      ).body;
      expect(grid.employees.map((e: { code: string }) => e.code)).toEqual(['B-1']);
      expect(grid.cells).toHaveLength(0);
      expect(grid.shifts).toHaveLength(0);
      expect((await req('get', SLUG_B, tb, '/scheduling/shifts').expect(200)).body).toHaveLength(0);
      expect((await req('get', SLUG_B, tb, '/scheduling/swaps').expect(200)).body).toHaveLength(0);
      expect((await req('get', SLUG_B, tb, '/scheduling/standing').expect(200)).body).toHaveLength(
        0,
      );
      await req('patch', SLUG_B, tb, `/scheduling/shifts/${shiftId.morning}`, {
        color: '#000000',
      }).expect(404);
      await req('put', SLUG_B, tb, '/scheduling/roster/cells', {
        cells: [cell('mkt1', F(0), shiftId.morning)],
      }).expect(404);
      await req('put', SLUG_B, tb, `/scheduling/standing/teams/${deptSales}`, {
        shiftDefinitionId: shiftId.morning,
      }).expect(404);
      // And RLS holds below the API: the app role sees nothing without a tenant context bound.
      const rows = await withTenantContext(tenantBId, (tx) => tx.shiftSwapRequest.findMany());
      expect(rows).toHaveLength(0);
      const leak = await withTenantContext(tenantBId, (tx) => tx.rosterAssignment.count());
      expect(leak).toBe(0);
    });
  });
});
