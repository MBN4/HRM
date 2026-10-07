/**
 * Proves step 8.1 Part 2 (attendance day-status classification) end to end over
 * real HTTP + Postgres, with REAL clock-in/out instants against a real Part-1
 * policy. See docs/conventions/attendance-status.md.
 *
 * New York in January is UTC-5 (so 09:00 local = 14:00Z); Doha is UTC+3 (09:00 local = 06:00Z).
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { toBranchLocal } from '../src/attendance/attendance-timezone.util';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'ast-test-a';
const SLUG_B = 'ast-test-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;
const POLICY = { startTime: '09:00', workHours: 8, breakHours: 1, graceMinutes: 15, halfDayThresholdHours: 4.5 };

describe('attendance day-status classification (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchUs: string;
  let branchQa: string;
  let n = 0;

  const emp: Record<'a' | 'q' | 'night' | 'x' | 'live', { id: string; userId: string | null }> = {} as never;
  const tokenOf: Record<string, string> = {};
  let managerUserId: string;

  const get = (slug: string, token: string, url: string) =>
    request(app.getHttpServer()).get(url).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`);
  const put = (token: string, url: string, body: unknown) =>
    request(app.getHttpServer()).put(url).set('Host', hostFor(SLUG_A)).set('Authorization', `Bearer ${token}`).send(body);
  const status = async (token: string, employeeId: string | null, from: string, to: string, slug = SLUG_A) =>
    get(slug, token, `/attendance/status?${employeeId ? `employeeId=${employeeId}&` : ''}from=${from}&to=${to}`);
  const dayMap = (body: { days: { date: string }[] }) => Object.fromEntries(body.days.map((d) => [d.date, d])) as Record<string, any>;

  async function makeUser(tenantId: string, email: string, role: string, managerId: string | null = null, branchId?: string) {
    const r = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: role } } });
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE', managerId } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: r.id } });
    if (branchId) await prisma.userBranch.create({ data: { tenantId, userId: user.id, branchId } });
    tokenOf[email] = jwt.sign({ sub: user.id, tenantId });
    return user;
  }
  async function makeEmployee(tenantId: string, branchId: string, userId: string | null) {
    n += 1;
    const e = await prisma.employee.create({
      data: { tenantId, branchId, userId, employeeCode: `AS-${n}-${Date.now() % 100000}`, firstName: `E${n}`, lastName: 'T', employmentType: 'FULL_TIME', joinDate: new Date('2020-01-01'), status: 'ACTIVE' },
    });
    return { id: e.id, userId };
  }
  const rec = (e: { id: string }, branchId: string, workDate: string, inIso: string, outIso: string | null) =>
    prisma.attendanceRecord.create({
      data: {
        tenantId: tenantAId, employeeId: e.id, branchId, workDate: new Date(`${workDate}T00:00:00Z`), clockInAt: new Date(inIso), clockInSource: 'WEB',
        clockOutAt: outIso ? new Date(outIso) : null, clockOutSource: outIso ? 'WEB' : null, status: outIso ? 'CLOSED' : 'OPEN',
      },
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);
    tenantAId = (await prisma.tenant.create({ data: { name: 'AST A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } })).id;
    tenantBId = (await prisma.tenant.create({ data: { name: 'AST B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } })).id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    branchUs = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'US', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchQa = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Doha', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;
    const branchB = (await prisma.branch.create({ data: { tenantId: tenantBId, name: 'B', countryCode: 'US', timezone: 'America/New_York' } })).id;

    // Reporting chain: gm -> manager -> memberA.   x reports to nobody.
    const gm = await makeUser(tenantAId, 'gm@ast.test', SYSTEM_ROLES.MANAGER);
    const mgr = await makeUser(tenantAId, 'mgr@ast.test', SYSTEM_ROLES.MANAGER, gm.id);
    managerUserId = mgr.id;
    const userA = await makeUser(tenantAId, 'a@ast.test', SYSTEM_ROLES.EMPLOYEE, mgr.id);
    const userX = await makeUser(tenantAId, 'x@ast.test', SYSTEM_ROLES.EMPLOYEE);
    await makeUser(tenantAId, 'hr@ast.test', SYSTEM_ROLES.HR_MANAGER);
    await makeUser(tenantAId, 'hrqa@ast.test', SYSTEM_ROLES.HR_MANAGER, null, branchQa);
    await makeUser(tenantBId, 'admin@astb.test', SYSTEM_ROLES.TENANT_ADMIN);
    emp.a = await makeEmployee(tenantAId, branchUs, userA.id);
    emp.x = await makeEmployee(tenantAId, branchUs, userX.id);
    emp.q = await makeEmployee(tenantAId, branchQa, null);
    emp.night = await makeEmployee(tenantAId, branchUs, null);
    emp.live = await makeEmployee(tenantAId, branchUs, null);
    await prisma.employee.create({ data: { tenantId: tenantBId, branchId: branchB, employeeCode: 'B-1', firstName: 'B', lastName: 'B', employmentType: 'FULL_TIME', joinDate: new Date('2020-01-01'), status: 'ACTIVE' } });

    await put(tokenOf['hr@ast.test'], '/working-hours/company', POLICY).expect(200);

    // ---- member A (US, New York, UTC-5), Mon 2026-01-05 .. Fri 2026-01-09 ----
    await rec(emp.a, branchUs, '2026-01-05', '2026-01-05T14:00:00Z', '2026-01-05T23:00:00Z'); // 09:00-18:00  on time, 9h
    await rec(emp.a, branchUs, '2026-01-06', '2026-01-06T14:10:00Z', '2026-01-06T23:10:00Z'); // 09:10-18:10  10 late (grace 15), 9h
    await rec(emp.a, branchUs, '2026-01-07', '2026-01-07T14:30:00Z', '2026-01-07T23:30:00Z'); // 09:30-18:30  30 late, 9h
    await rec(emp.a, branchUs, '2026-01-08', '2026-01-08T14:00:00Z', '2026-01-08T21:00:00Z'); // 09:00-16:00  7h, left 2h early
    await rec(emp.a, branchUs, '2026-01-09', '2026-01-09T14:00:00Z', '2026-01-09T17:30:00Z'); // 09:00-12:30  3.5h half day
    await rec(emp.a, branchUs, '2026-01-10', '2026-01-10T14:50:00Z', '2026-01-10T16:00:00Z'); // Saturday shift: still NEUTRAL
    await prisma.leaveRequest.create({ data: { tenantId: tenantAId, employeeId: emp.a.id, leaveType: 'ANNUAL', startDate: new Date('2026-01-12'), endDate: new Date('2026-01-12'), days: 1, status: 'APPROVED' } });
    await prisma.leaveRequest.create({ data: { tenantId: tenantAId, employeeId: emp.a.id, leaveType: 'ANNUAL', startDate: new Date('2026-01-13'), endDate: new Date('2026-01-13'), days: 1, status: 'PENDING' } });

    // ---- member Q (Qatar, Doha, UTC+3, weekend Fri/Sat) ----
    await rec(emp.q, branchQa, '2026-01-08', '2026-01-08T06:20:00Z', '2026-01-08T15:20:00Z'); // Thu 09:20 local, 9h -> RED late beyond grace
    await rec(emp.q, branchQa, '2026-01-12', '2026-01-12T06:00:00Z', '2026-01-12T15:00:00Z'); // Mon 09:00 local -> GREEN

    // ---- night-shift member: policy 22:00, 7+1, crosses midnight ----
    await put(tokenOf['hr@ast.test'], `/working-hours/members/${emp.night.id}`, { startTime: '22:00', workHours: 7, breakHours: 1, graceMinutes: 15, halfDayThresholdHours: 4 }).expect(200);
    // Wed 2026-01-14 22:05 NY (03:05Z on the 15th) -> Thu 06:10 NY (11:10Z), 8h05m. workDate is the day the shift STARTED.
    await rec(emp.night, branchUs, '2026-01-14', '2026-01-15T03:05:00Z', '2026-01-15T11:10:00Z');

    // ---- member currently clocked in (today, in the branch's own timezone) ----
    const today = toBranchLocal(new Date(), 'America/New_York').calendarDate.toISOString().slice(0, 10);
    await rec(emp.live, branchUs, today, new Date(Date.now() - 2 * 3_600_000).toISOString(), null);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('the colour rules, with real instants', () => {
    let days: Record<string, any>;
    let body: any;
    beforeAll(async () => {
      body = (await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-01', '2026-01-14')).body;
      days = dayMap(body);
    });

    it('on time + full hours -> GREEN / ON_TIME', () => {
      expect(days['2026-01-05']).toMatchObject({ status: 'GREEN', reason: 'ON_TIME', isLate: false, minutesLate: 0, hoursWorked: 9, requiredHours: 9, policySource: 'COMPANY' });
    });
    it('10 min late with grace 15 -> YELLOW / WITHIN_GRACE', () => {
      expect(days['2026-01-06']).toMatchObject({ status: 'YELLOW', reason: 'WITHIN_GRACE', isLate: true, minutesLate: 10, isShortDay: false });
    });
    it('30 min late -> RED / LATE_BEYOND_GRACE', () => {
      expect(days['2026-01-07']).toMatchObject({ status: 'RED', reason: 'LATE_BEYOND_GRACE', minutesLate: 30, hoursWorked: 9 });
    });
    it('clocked out early / short of the required hours -> RED / EARLY_OUT with minutesEarly', () => {
      expect(days['2026-01-08']).toMatchObject({ status: 'RED', reason: 'EARLY_OUT', isEarlyOut: true, minutesEarly: 120, isShortDay: true, isHalfDay: false, hoursWorked: 7 });
    });
    it('below the half-day threshold -> RED + isHalfDay', () => {
      expect(days['2026-01-09']).toMatchObject({ status: 'RED', isHalfDay: true, isShortDay: true, hoursWorked: 3.5 });
      expect(days['2026-01-09'].reasons).toEqual(expect.arrayContaining(['HALF_DAY', 'EARLY_OUT']));
      expect(days['2026-01-09'].reason).toBe('HALF_DAY');
    });
    it('weekend (US Sat/Sun) -> NEUTRAL even when a shift was worked', () => {
      expect(days['2026-01-10']).toMatchObject({ status: 'NEUTRAL', reason: 'WEEKEND' });
      expect(days['2026-01-10'].clockIn).not.toBeNull();
      expect(days['2026-01-11']).toMatchObject({ status: 'NEUTRAL', reason: 'WEEKEND' });
    });
    it("public holiday from the pack -> NEUTRAL / HOLIDAY (New Year's Day)", () => {
      expect(days['2026-01-01']).toMatchObject({ status: 'NEUTRAL', reason: 'HOLIDAY' });
    });
    it('approved leave -> NEUTRAL / ON_LEAVE; a merely PENDING leave does not count', () => {
      expect(days['2026-01-12']).toMatchObject({ status: 'NEUTRAL', reason: 'ON_LEAVE' });
      expect(days['2026-01-13']).toMatchObject({ status: 'RED', reason: 'ABSENT' });
    });
    it('returns the policy used, the branch timezone and a per-status summary', () => {
      expect(body.timezone).toBe('America/New_York');
      expect(body.policy).toMatchObject({ source: 'COMPANY', startTime: '09:00', requiredHours: 9, graceMinutes: 15 });
      expect(body.summary).toMatchObject({ GREEN: 1, YELLOW: 1 });
      expect(body.summary.RED).toBeGreaterThanOrEqual(4);
    });
  });

  it('currently clocked in with no clock-out -> IN_PROGRESS (no forced colour)', async () => {
    const today = toBranchLocal(new Date(), 'America/New_York').calendarDate.toISOString().slice(0, 10);
    const d = dayMap((await status(tokenOf['hr@ast.test'], emp.live.id, today, today)).body)[today];
    expect(d).toMatchObject({ status: 'IN_PROGRESS', reason: 'CLOCKED_IN', clockOut: null });
    expect(d.hoursWorked).toBeGreaterThanOrEqual(1.9);
  });

  it('a future day is NEUTRAL / FUTURE, and a day before the join date is NOT_EMPLOYED', async () => {
    const future = dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2999-01-04', '2999-01-04')).body);
    expect(future['2999-01-04']).toMatchObject({ status: 'NEUTRAL', reason: 'FUTURE' });
    const old = dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2019-06-03', '2019-06-03')).body);
    expect(old['2019-06-03']).toMatchObject({ status: 'NEUTRAL', reason: 'NOT_EMPLOYED' });
  });

  describe('precedence from Part 1 changes the classification', () => {
    it("a member override changes the thresholds: tightening grace turns YELLOW into RED", async () => {
      expect(dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-06', '2026-01-06')).body)['2026-01-06'].status).toBe('YELLOW');
      await put(tokenOf['hr@ast.test'], `/working-hours/members/${emp.a.id}`, { ...POLICY, graceMinutes: 5 }).expect(200);
      const d = dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-06', '2026-01-06')).body)['2026-01-06'];
      expect(d).toMatchObject({ status: 'RED', reason: 'LATE_BEYOND_GRACE', policySource: 'MEMBER' });
      // and an earlier start makes the previously on-time day late
      await put(tokenOf['hr@ast.test'], `/working-hours/members/${emp.a.id}`, { ...POLICY, startTime: '08:00' }).expect(200);
      const mon = dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-05', '2026-01-05')).body)['2026-01-05'];
      expect(mon).toMatchObject({ status: 'RED', minutesLate: 60 });
      await call_del(`/working-hours/members/${emp.a.id}`);
      expect(dayMap((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-05', '2026-01-05')).body)['2026-01-05'].status).toBe('GREEN');
    });
  });
  const call_del = (url: string) =>
    request(app.getHttpServer()).delete(url).set('Host', hostFor(SLUG_A)).set('Authorization', `Bearer ${tokenOf['hr@ast.test']}`).expect(200);

  describe('timezones + midnight', () => {
    it("a Doha member is judged in Doha's own local time (09:20 local, though 06:20 UTC), with Fri/Sat weekend", async () => {
      const body = (await status(tokenOf['hr@ast.test'], emp.q.id, '2026-01-08', '2026-01-12')).body;
      const d = dayMap(body);
      expect(body.timezone).toBe('Asia/Qatar');
      expect(d['2026-01-08']).toMatchObject({ status: 'RED', reason: 'LATE_BEYOND_GRACE', minutesLate: 20 });
      expect(d['2026-01-09']).toMatchObject({ status: 'NEUTRAL', reason: 'WEEKEND' }); // Friday
      expect(d['2026-01-10']).toMatchObject({ status: 'NEUTRAL', reason: 'WEEKEND' }); // Saturday
      expect(d['2026-01-11']).toMatchObject({ status: 'RED', reason: 'ABSENT' }); // Sunday is a QA WORKING day (it is a US weekend day)
      expect(d['2026-01-12']).toMatchObject({ status: 'GREEN', reason: 'ON_TIME' });
    });

    it('a shift crossing midnight is attributed to the day it STARTED and classified there', async () => {
      const d = dayMap((await status(tokenOf['hr@ast.test'], emp.night.id, '2026-01-14', '2026-01-15')).body);
      expect(d['2026-01-14']).toMatchObject({ status: 'YELLOW', reason: 'WITHIN_GRACE', minutesLate: 5, hoursWorked: 8.08, policySource: 'MEMBER' });
      expect(d['2026-01-14'].clockOut).toBe('2026-01-15T11:10:00.000Z');
      expect(d['2026-01-15']).toMatchObject({ clockIn: null, reason: 'ABSENT' }); // nothing leaked onto the next calendar day
    });
  });

  describe('who may read whose status', () => {
    it('a member reads their OWN (no employeeId) and by their own id', async () => {
      const own = await status(tokenOf['a@ast.test'], null, '2026-01-05', '2026-01-06');
      expect(own.status).toBe(200);
      expect(own.body.employeeId).toBe(emp.a.id);
      await status(tokenOf['a@ast.test'], emp.a.id, '2026-01-05', '2026-01-06').then((r) => expect(r.status).toBe(200));
    });
    it("a member cannot read someone else's", async () => {
      expect((await status(tokenOf['a@ast.test'], emp.x.id, '2026-01-05', '2026-01-06')).status).toBe(403);
      expect((await status(tokenOf['x@ast.test'], emp.a.id, '2026-01-05', '2026-01-06')).status).toBe(403);
    });
    it("a manager reads their report's (and their report's reports'), but not an unrelated colleague's", async () => {
      expect((await status(tokenOf['mgr@ast.test'], emp.a.id, '2026-01-05', '2026-01-06')).status).toBe(200);
      expect((await status(tokenOf['gm@ast.test'], emp.a.id, '2026-01-05', '2026-01-06')).status).toBe(200); // two levels up
      expect((await status(tokenOf['mgr@ast.test'], emp.x.id, '2026-01-05', '2026-01-06')).status).toBe(403);
    });
    it('HR / admin read anyone in their branch scope; a branch-restricted HR cannot see another branch (404)', async () => {
      expect((await status(tokenOf['hr@ast.test'], emp.x.id, '2026-01-05', '2026-01-06')).status).toBe(200);
      expect((await status(tokenOf['hrqa@ast.test'], emp.q.id, '2026-01-08', '2026-01-08')).status).toBe(200);
      expect((await status(tokenOf['hrqa@ast.test'], emp.a.id, '2026-01-05', '2026-01-06')).status).toBe(404);
    });
    it("tenant B can't see tenant A's employees (404)", async () => {
      expect((await status(tokenOf['admin@astb.test'], emp.a.id, '2026-01-05', '2026-01-06', SLUG_B)).status).toBe(404);
    });
    it('validates the range (from <= to, at most 93 days, YYYY-MM-DD)', async () => {
      expect((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-02-01', '2026-01-01')).status).toBe(400);
      expect((await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-01', '2026-06-01')).status).toBe(400);
      expect((await status(tokenOf['hr@ast.test'], emp.a.id, '01/01/2026', '2026-01-02')).status).toBe(400);
    });
  });

  it('a whole month is classified in one call', async () => {
    const t = Date.now();
    const body = (await status(tokenOf['hr@ast.test'], emp.a.id, '2026-01-01', '2026-01-31')).body;
    expect(body.days).toHaveLength(31);
    expect(Date.now() - t).toBeLessThan(3000);
    void managerUserId;
  });
});
