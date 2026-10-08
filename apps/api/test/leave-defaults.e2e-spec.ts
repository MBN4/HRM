/**
 * Step 8.1 Part 4 — default leave allocation (docs/conventions/leave.md § Default leave allocation), over real
 * HTTP + DB: an admin sets per-type defaults for a country, members receive them through the real 1.2 balance
 * model, the Country Pack legal floor is enforced with a clear message, new members inherit, raises apply to
 * existing balances without touching earned/used days (lowering only affects new allocations), RBAC is
 * deny-by-default, and tenants are isolated. JWTs are minted directly (same rationale as every e2e suite here).
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const A = 'leave-defaults-a';
const B = 'leave-defaults-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const YEAR = new Date().getUTCFullYear();

describe('leave defaults (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchAUs: string;
  let branchAQa: string;
  let branchBUs: string;
  let tokenAdmin: string;
  let tokenHr: string;
  let tokenManager: string;
  let tokenEmployee: string;
  let tokenAdminB: string;
  let n = 0;

  const host = (slug: string) => `${slug}.${BASE_DOMAIN}`;
  const req = (method: 'get' | 'put' | 'post', path: string, token: string, slug = A, body?: unknown) =>
    request(app.getHttpServer())[method](path).set('Host', host(slug)).set('Authorization', `Bearer ${token}`).send(body as object);

  async function employee(tenantId: string, branchId: string, extra: Record<string, unknown> = {}) {
    n += 1;
    return prisma.employee.create({
      data: { tenantId, branchId, employeeCode: `LD-${n}`, firstName: 'Def', lastName: `Emp${n}`, employmentType: 'FULL_TIME', joinDate: new Date('2020-01-01'), status: 'ACTIVE', ...extra },
    });
  }
  async function userWithRole(tenantId: string, roleName: string, email: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: roleName } } });
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    return user;
  }
  const balances = async (tenantId: string, employeeId: string) =>
    Object.fromEntries((await prisma.leaveBalance.findMany({ where: { tenantId, employeeId, periodYear: YEAR } })).map((b) => [b.leaveType, b]));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prisma.tenant.deleteMany({ where: { slug: { in: [A, B] } } });
    await seedCountryPacks(prisma);
    const ta = await prisma.tenant.create({ data: { name: 'LD A', slug: A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    const tb = await prisma.tenant.create({ data: { name: 'LD B', slug: B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    tenantAId = ta.id;
    tenantBId = tb.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    branchAUs = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'US', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchAQa = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'QA', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;
    branchBUs = (await prisma.branch.create({ data: { tenantId: tenantBId, name: 'US', countryCode: 'US', timezone: 'America/New_York' } })).id;
    const sign = (u: { id: string }, tenantId: string) => jwt.sign({ sub: u.id, tenantId });
    tokenAdmin = sign(await userWithRole(tenantAId, SYSTEM_ROLES.TENANT_ADMIN, 'admin@ld-a.test'), tenantAId);
    tokenHr = sign(await userWithRole(tenantAId, SYSTEM_ROLES.HR_MANAGER, 'hr@ld-a.test'), tenantAId);
    tokenManager = sign(await userWithRole(tenantAId, SYSTEM_ROLES.MANAGER, 'mgr@ld-a.test'), tenantAId);
    tokenEmployee = sign(await userWithRole(tenantAId, SYSTEM_ROLES.EMPLOYEE, 'emp@ld-a.test'), tenantAId);
    tokenAdminB = sign(await userWithRole(tenantBId, SYSTEM_ROLES.TENANT_ADMIN, 'admin@ld-b.test'), tenantBId);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [A, B] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  let usFloor: { annualDays: number; sickDays: number; maternityDays: number; paternityDays: number };
  let qaFloor: typeof usFloor;

  it('lists each country the tenant has branches in, with the legal floor, override and effective days', async () => {
    const res = await req('get', '/leave/defaults', tokenHr).expect(200);
    expect(res.body.year).toBe(YEAR);
    const us = res.body.countries.find((c: { countryCode: string }) => c.countryCode === 'US');
    const qa = res.body.countries.find((c: { countryCode: string }) => c.countryCode === 'QA');
    expect(us.legalFloor.annualDays).toBe(10);
    expect(qa.legalFloor.annualDays).toBe(21);
    expect(us.override).toBeNull();
    expect(us.effective).toEqual(us.legalFloor);
    usFloor = us.legalFloor;
    qaFloor = qa.legalFloor;
  });

  it('admin sets defaults -> existing members receive those entitlements via the real balance model', async () => {
    const e1 = await employee(tenantAId, branchAUs);
    const e2 = await employee(tenantAId, branchAUs);
    const qaMember = await employee(tenantAId, branchAQa);
    const res = await req('put', '/leave/defaults/US', tokenAdmin, A, { annualDays: usFloor.annualDays + 5, sickDays: usFloor.sickDays + 2, maternityDays: usFloor.maternityDays + 10 }).expect(200);
    expect(res.body.country.effective.annualDays).toBe(usFloor.annualDays + 5);
    expect(res.body.country.override).toEqual({ annualDays: usFloor.annualDays + 5, sickDays: usFloor.sickDays + 2, maternityDays: usFloor.maternityDays + 10 });
    expect(res.body.applied.members).toBeGreaterThanOrEqual(2);
    expect(res.body.applied.balancesCreated).toBeGreaterThanOrEqual(8);

    for (const e of [e1, e2]) {
      const b = await balances(tenantAId, e.id);
      expect(b.ANNUAL.entitledDays).toBe(usFloor.annualDays + 5);
      expect(b.ANNUAL.accruedDays).toBe(0); // accrued types start at 0 and accrue monthly
      expect(b.SICK.entitledDays).toBe(usFloor.sickDays + 2);
      expect(b.MATERNITY.entitledDays).toBe(usFloor.maternityDays + 10);
      expect(b.MATERNITY.accruedDays).toBe(usFloor.maternityDays + 10); // non-accrued: available in full
      expect(b.PATERNITY.entitledDays).toBe(usFloor.paternityDays); // untouched key -> pack value
    }
    // ...and the member sees them through the ordinary leave API.
    const own = await req('get', `/leave/balances?employeeId=${e1.id}`, tokenHr).expect(200);
    expect(own.body.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL').entitledDays).toBe(usFloor.annualDays + 5);
    // A different country's members are untouched (QA has its own pack + override).
    expect(Object.keys(await balances(tenantAId, qaMember.id))).toHaveLength(0);
  });

  it('REJECTS a value below the Country Pack legal floor with the legal minimum in the message; at the floor succeeds', async () => {
    const below = usFloor.annualDays - 1;
    const bad = await req('put', '/leave/defaults/US', tokenHr, A, { annualDays: below }).expect(400);
    expect(bad.body.message).toContain('legal minimum');
    expect(bad.body.message).toContain(String(usFloor.annualDays));
    expect(bad.body.message).toContain('Annual leave');
    // nothing changed
    const after = await req('get', '/leave/defaults', tokenHr).expect(200);
    expect(after.body.countries.find((c: { countryCode: string }) => c.countryCode === 'US').effective.annualDays).toBe(usFloor.annualDays + 5);
    // QA has its own (higher) floor: the US number is illegal there
    await req('put', '/leave/defaults/QA', tokenHr, A, { annualDays: usFloor.annualDays }).expect(400);
    // exactly AT the floor is fine
    await req('put', '/leave/defaults/QA', tokenHr, A, { annualDays: qaFloor.annualDays }).expect(200);
    // malformed input
    await req('put', '/leave/defaults/US', tokenHr, A, {}).expect(400);
    await req('put', '/leave/defaults/US', tokenHr, A, { annualDays: -1 }).expect(400);
    await req('put', '/leave/defaults/US', tokenHr, A, { casualDays: 3 }).expect(400);
  });

  it('a new member created afterwards inherits the CURRENT defaults (lazily, at first touch)', async () => {
    const fresh = await employee(tenantAId, branchAUs);
    const res = await req('post', `/leave/balances/${fresh.id}/adjust`, tokenHr, A, { leaveType: 'ANNUAL', deltaDays: 0 }).expect(201);
    expect(res.body.entitledDays).toBe(usFloor.annualDays + 5);
  });

  it('going forward: a RAISE lifts existing balances but never rewrites earned/used days; a LOWER never takes anything away', async () => {
    const mid = await employee(tenantAId, branchAUs);
    await prisma.leaveBalance.create({ data: { tenantId: tenantAId, employeeId: mid.id, leaveType: 'ANNUAL', periodYear: YEAR, entitledDays: 12, accruedDays: 4, carriedOverDays: 1, usedDays: 2 } });
    await prisma.leaveBalance.create({ data: { tenantId: tenantAId, employeeId: mid.id, leaveType: 'PATERNITY', periodYear: YEAR, entitledDays: 5, accruedDays: 5, usedDays: 1 } });

    const target = usFloor.annualDays + 12;
    const res = await req('put', '/leave/defaults/US', tokenAdmin, A, { annualDays: target, paternityDays: usFloor.paternityDays + 7 }).expect(200);
    expect(res.body.applied.balancesRaised).toBeGreaterThanOrEqual(1);
    let b = await balances(tenantAId, mid.id);
    expect(b.ANNUAL).toMatchObject({ entitledDays: target, accruedDays: 4, carriedOverDays: 1, usedDays: 2 }); // cap raised, history intact
    expect(b.PATERNITY.entitledDays).toBe(usFloor.paternityDays + 7);
    expect(b.PATERNITY.accruedDays).toBe(5 + (usFloor.paternityDays + 7 - 5)); // non-accrued: the increase is granted
    expect(b.PATERNITY.usedDays).toBe(1);

    // lowering (still >= floor) leaves the existing row alone but new members get the lower number
    await req('put', '/leave/defaults/US', tokenAdmin, A, { annualDays: usFloor.annualDays }).expect(200);
    b = await balances(tenantAId, mid.id);
    expect(b.ANNUAL.entitledDays).toBe(target);
    const later = await employee(tenantAId, branchAUs);
    const res2 = await req('post', `/leave/balances/${later.id}/adjust`, tokenHr, A, { leaveType: 'ANNUAL', deltaDays: 0 }).expect(201);
    expect(res2.body.entitledDays).toBe(usFloor.annualDays);
  });

  it('preserves the tenant\'s OTHER override sections and is audited', async () => {
    await req('put', '/country-packs/overrides/US', tokenAdmin, A, { requiredEmployeeFields: ['SSN'], leaveDefaults: { annualDays: usFloor.annualDays + 3 } }).expect(200);
    await req('put', '/leave/defaults/US', tokenAdmin, A, { sickDays: usFloor.sickDays + 1 }).expect(200);
    const row = await prisma.tenantCountryOverride.findUniqueOrThrow({ where: { tenantId_countryCode: { tenantId: tenantAId, countryCode: 'US' } } });
    expect(row.overrides).toMatchObject({ requiredEmployeeFields: ['SSN'], leaveDefaults: { annualDays: usFloor.annualDays + 3, sickDays: usFloor.sickDays + 1 } });
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, entityType: 'LeaveDefaults' }, orderBy: { createdAt: 'desc' } });
    expect(audit).toBeTruthy();
  });

  it('RBAC: members and managers get 403 on both routes; HR / admin are allowed', async () => {
    for (const token of [tokenEmployee, tokenManager]) {
      await req('get', '/leave/defaults', token).expect(403);
      await req('put', '/leave/defaults/US', token, A, { annualDays: 30 }).expect(403);
    }
    await req('get', '/leave/defaults', tokenHr).expect(200);
    await req('get', '/leave/defaults', tokenAdmin).expect(200);
  });

  it('cross-tenant isolation: another tenant\'s admin neither sees nor changes this tenant\'s defaults or balances', async () => {
    const bMember = await employee(tenantBId, branchBUs);
    const listB = await req('get', '/leave/defaults', tokenAdminB, B).expect(200);
    expect(listB.body.countries.map((c: { countryCode: string }) => c.countryCode)).toEqual(['US']);
    expect(listB.body.countries[0].override).toBeNull(); // A's overrides are invisible
    const before = await prisma.tenantCountryOverride.findUniqueOrThrow({ where: { tenantId_countryCode: { tenantId: tenantAId, countryCode: 'US' } } });
    await req('put', '/leave/defaults/US', tokenAdminB, B, { annualDays: usFloor.annualDays + 20 }).expect(200);
    const after = await prisma.tenantCountryOverride.findUniqueOrThrow({ where: { tenantId_countryCode: { tenantId: tenantAId, countryCode: 'US' } } });
    expect(after.overrides).toEqual(before.overrides);
    expect((await balances(tenantBId, bMember.id)).ANNUAL.entitledDays).toBe(usFloor.annualDays + 20);
    // tenant A's members never got B's number; and A's token against B's host is rejected
    expect(await prisma.leaveBalance.count({ where: { tenantId: tenantAId, entitledDays: usFloor.annualDays + 20 } })).toBe(0);
    await req('get', '/leave/defaults', tokenAdmin, B).expect(401);
  });
});
