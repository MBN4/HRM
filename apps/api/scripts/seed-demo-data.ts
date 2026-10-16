/**
 * DEV-ONLY demo data for the dashboards — NOT part of the real seed
 * (`packages/db/prisma/seed.ts`) and never run by any deploy/migration job.
 *
 * Populates the `acme-demo` tenant (US + Doha branches) with a realistic
 * workforce so /dashboard and /analytics (portal) and the vendor console's
 * overview show real charts: departments, ~70 employees (mixed type/gender,
 * joiners and leavers inside the last 90 days), ~100 days of attendance
 * summaries + recent clock records, leave balances + requests, one finalized
 * payroll run per branch (fabricated lines — NOT engine output), benefit
 * plans + enrollments. It also adds three extra DEMO tenants + subscriptions
 * so the vendor console's tenant/billing charts have something to draw, and
 * two demo logins (US + Qatar branch) for checking LTR vs real RTL.
 *
 * Idempotent: every row is keyed by a natural key (employee code, tenant slug,
 * ...) or deleted-and-recreated by a `[demo]` marker; data is generated from a
 * fixed-seed PRNG relative to "today", so re-running refreshes the window
 * without duplicating anything.
 *
 * Run (after `pnpm db:migrate`, the real seed, and the rollups below):
 *   pnpm --filter @hrm/api run seed:demo
 *   pnpm --filter @hrm/api run demo:rollup     # fills the precomputed rollups
 * See docs/conventions/design-system.md § Demo data.
 */
import { hash } from '@node-rs/argon2';
import { prisma, SYSTEM_ROLES } from '@hrm/db';
import { branchLocalToUtc } from '../src/attendance/attendance-timezone.util';
import { scoreResume } from '../src/recruitment/screening/screening-scorer.util';
import { parsedResumeSchema, screeningCriteriaConfigSchema } from '@hrm/shared';
import type { AttendanceDayStatus, EmploymentType, Gender, LeaveRequestStatus, LeaveType } from '@hrm/db';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const TENANT_SLUG = 'acme-demo';
const DEMO_PASSWORD = 'DemoPass-123!';
/** The one-time temporary password of the demo user that is mid-onboarding (mustChangePassword=true) — see the "team access" section below. */
const DEMO_TEMP_PASSWORD = 'Temp-Pass-123!';
// Step 11.1 — DEMO ONLY: a fixed kiosk device token + PINs so the kiosk screen works out of the box.
const DEMO_KIOSK_TOKEN = 'kio_demo_acme_hq_front_desk_token_0001';
const DEMO_KIOSK_PINS: Record<string, string> = { 'CHAIN-INTERN': '111111', 'CHAIN-LEAD': '222222', 'CHAIN-PM': '333333' };
const ARGON2ID = 2;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 100;

// Small deterministic PRNG so a re-run regenerates the same shape.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261006);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const weighted = <T>(xs: readonly [T, number][]): T => {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [x, w] of xs) {
    r -= w;
    if (r <= 0) return x;
  }
  return xs[0][0];
};

const todayUtc = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
})();
const daysAgo = (n: number) => new Date(todayUtc.getTime() - n * DAY_MS);

const FIRST_US = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'Lucas', 'Mia', 'Logan', 'Amelia', 'Elijah', 'Harper', 'James', 'Evelyn', 'Aiden', 'Abigail', 'Jack'];
const FIRST_QA = ['Fatima', 'Mohammed', 'Aisha', 'Yousef', 'Mariam', 'Khalid', 'Noura', 'Omar', 'Layla', 'Hamad', 'Sara', 'Tariq', 'Huda', 'Ali', 'Reem'];
const LAST = ['Carter', 'Nguyen', 'Patel', 'Rivera', 'Brooks', 'Kim', 'Hughes', 'Foster', 'Al-Thani', 'Haddad', 'Khalil', 'Nasser', 'Rahman', 'Siddiqui', 'Morgan', 'Reed', 'Bennett', 'Cole'];
const DESIGNATIONS = ['Software Engineer', 'Sales Executive', 'HR Generalist', 'Operations Analyst', 'Accountant', 'Team Lead', 'Support Specialist'];

interface BranchPlan {
  name: string;
  countryCode: 'US' | 'QA';
  weekend: number[]; // getUTCDay(): 0=Sun..6=Sat
  count: number;
  firstNames: string[];
  departments: string[];
  codePrefix: string;
  currency: string;
}
const PLANS: BranchPlan[] = [
  { name: 'Acme US HQ', countryCode: 'US', weekend: [0, 6], count: 46, firstNames: FIRST_US, departments: ['Engineering', 'Sales', 'People & Culture', 'Operations'], codePrefix: 'DEMO-US', currency: 'USD' },
  { name: 'Acme Doha Office', countryCode: 'QA', weekend: [5, 6], count: 26, firstNames: FIRST_QA, departments: ['Operations', 'Finance', 'Sales'], codePrefix: 'DEMO-QA', currency: 'QAR' },
];

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) throw new Error(`Tenant "${TENANT_SLUG}" not found — run the real seed first (pnpm --filter @hrm/db run seed).`);
  const tenantId = tenant.id;

  const passwordHash = await hash(DEMO_PASSWORD, { algorithm: ARGON2ID });
  const adminUser = await prisma.user.findFirst({ where: { tenantId, email: 'admin@acme-demo.local' } });
  const hrRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.HR_MANAGER } } });

  // ---- designations --------------------------------------------------------
  const designationIds: string[] = [];
  for (const name of DESIGNATIONS) {
    const d = await prisma.designation.upsert({ where: { tenantId_name: { tenantId, name } }, update: {}, create: { tenantId, name } });
    designationIds.push(d.id);
  }

  // ---- branches / departments / employees -----------------------------------
  const employeesByBranch: Record<string, { id: string; branchId: string; joinDate: Date; status: string; code: string }[]> = {};
  const demoLogins: { email: string; branch: string }[] = [];

  for (const plan of PLANS) {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: plan.name } } });
    const deptIds: string[] = [];
    for (const name of plan.departments) {
      const dept = await prisma.department.upsert({
        where: { tenantId_branchId_name: { tenantId, branchId: branch.id, name } },
        update: {},
        create: { tenantId, branchId: branch.id, name },
      });
      deptIds.push(dept.id);
    }

    const rows: { id: string; branchId: string; joinDate: Date; status: string; code: string }[] = [];
    for (let i = 1; i <= plan.count; i += 1) {
      const code = `${plan.codePrefix}-${String(i).padStart(3, '0')}`;
      // ~15% joined in the last 30 days, ~15% in the 30-90 window, the rest 6-24 months ago.
      const bucket = rand();
      const joinedDaysAgo = bucket < 0.15 ? Math.floor(rand() * 28) + 1 : bucket < 0.3 ? 30 + Math.floor(rand() * 58) : 180 + Math.floor(rand() * 560);
      const joinDate = daysAgo(joinedDaysAgo);
      // ~7% left in the last 60 days (never someone who joined after leaving).
      const leaver = joinedDaysAgo > 70 && rand() < 0.07;
      const terminatedAt = leaver ? daysAgo(1 + Math.floor(rand() * 55)) : null;
      const gender = weighted<Gender>([['FEMALE', 46], ['MALE', 48], ['OTHER', 3], ['UNDISCLOSED', 3]]);
      const employmentType = weighted<EmploymentType>([['FULL_TIME', 72], ['PART_TIME', 10], ['CONTRACT', 14], ['INTERN', 4]]);
      const firstName = pick(plan.firstNames);
      const lastName = pick(LAST);

      const data = {
        firstName,
        lastName,
        gender,
        branchId: branch.id,
        departmentId: pick(deptIds),
        designationId: pick(designationIds),
        employmentType,
        joinDate,
        status: leaver ? ('TERMINATED' as const) : ('ACTIVE' as const),
        terminatedAt,
        // Country-pack required statutory keys (US: SSN-style, QA: Qatar ID) so these rows pass the real validators if edited in the UI.
        statutoryFields: plan.countryCode === 'QA' ? { QID: `2${String(90000000000 + i * 7919).slice(0, 10)}` } : { SSN: `900-${String(10 + (i % 80)).padStart(2, '0')}-${String(1000 + i).slice(-4)}` },
      };
      const emp = await prisma.employee.upsert({
        where: { tenantId_employeeCode: { tenantId, employeeCode: code } },
        update: data,
        create: { tenantId, employeeCode: code, ...data },
      });
      rows.push({ id: emp.id, branchId: branch.id, joinDate, status: data.status, code });
    }
    employeesByBranch[branch.id] = rows;

    // One real login per branch, tied to that branch's first employee (so the portal resolves the BRANCH's country pack — Doha => RTL Arabic).
    const email = `demo.${plan.countryCode.toLowerCase()}@acme-demo.local`;
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email } },
      update: { hashedPassword: passwordHash, status: 'ACTIVE' },
      create: { tenantId, email, hashedPassword: passwordHash, status: 'ACTIVE' },
    });
    const hasRole = await prisma.userRole.findFirst({ where: { tenantId, userId: user.id, roleId: hrRole.id } });
    if (!hasRole) await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: hrRole.id } });
    await prisma.employee.update({ where: { id: rows[0].id }, data: { userId: user.id, status: 'ACTIVE', terminatedAt: null, joinDate: daysAgo(400) } });
    rows[0].status = 'ACTIVE';
    demoLogins.push({ email, branch: plan.name });
  }

  const allEmployees = Object.values(employeesByBranch).flat();
  const planByBranch = new Map<string, BranchPlan>();
  for (const plan of PLANS) {
    const b = await prisma.branch.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: plan.name } } });
    planByBranch.set(b.id, plan);
  }

  // ---- attendance summaries (what the analytics rollup reads) ---------------
  const empIds = allEmployees.map((e) => e.id);
  await prisma.attendanceDailySummary.deleteMany({ where: { tenantId, employeeId: { in: empIds } } });
  const summaryRows: {
    tenantId: string;
    employeeId: string;
    branchId: string;
    workDate: Date;
    status: AttendanceDayStatus;
    workedMinutes: number;
    overtimeMinutes: number;
    lateMinutes: number;
  }[] = [];
  for (const emp of allEmployees) {
    const plan = planByBranch.get(emp.branchId)!;
    for (let n = HISTORY_DAYS; n >= 1; n -= 1) {
      const date = daysAgo(n);
      if (date < emp.joinDate) continue;
      let status: AttendanceDayStatus;
      let worked = 0;
      let late = 0;
      let overtime = 0;
      if (plan.weekend.includes(date.getUTCDay())) status = 'WEEKEND';
      else {
        status = weighted<AttendanceDayStatus>([['PRESENT', 80], ['LATE', 8], ['ABSENT', 5], ['ON_LEAVE', 6], ['HOLIDAY', 1]]);
        if (status === 'PRESENT' || status === 'LATE') {
          worked = 450 + Math.floor(rand() * 90);
          overtime = rand() < 0.15 ? 30 + Math.floor(rand() * 90) : 0;
          late = status === 'LATE' ? 5 + Math.floor(rand() * 40) : 0;
        }
      }
      summaryRows.push({ tenantId, employeeId: emp.id, branchId: emp.branchId, workDate: date, status, workedMinutes: worked, overtimeMinutes: overtime, lateMinutes: late });
    }
  }
  for (let i = 0; i < summaryRows.length; i += 2000) {
    await prisma.attendanceDailySummary.createMany({ data: summaryRows.slice(i, i + 2000), skipDuplicates: true });
  }

  // ---- recent clock records (the attendance screens) -------------------------
  await prisma.attendanceRecord.deleteMany({ where: { tenantId, employeeId: { in: empIds }, workDate: { gte: daysAgo(14) } } });
  const records = summaryRows
    .filter((r) => (r.status === 'PRESENT' || r.status === 'LATE') && r.workDate >= daysAgo(14))
    .map((r) => {
      const clockIn = new Date(r.workDate.getTime() + (9 * 60 + r.lateMinutes) * 60_000);
      return {
        tenantId,
        employeeId: r.employeeId,
        branchId: r.branchId,
        workDate: r.workDate,
        clockInAt: clockIn,
        clockInSource: 'WEB' as const,
        clockOutAt: new Date(clockIn.getTime() + r.workedMinutes * 60_000),
        clockOutSource: 'WEB' as const,
        status: 'CLOSED' as const,
        workedMinutes: r.workedMinutes,
        overtimeMinutes: r.overtimeMinutes,
        lateMinutes: r.lateMinutes,
      };
    });
  for (let i = 0; i < records.length; i += 2000) await prisma.attendanceRecord.createMany({ data: records.slice(i, i + 2000) });

  // ---- leave balances + requests ---------------------------------------------
  const year = todayUtc.getUTCFullYear();
  const LEAVE: [LeaveType, number][] = [['ANNUAL', 20], ['SICK', 10]];
  for (const emp of allEmployees) {
    for (const [leaveType, entitled] of LEAVE) {
      const used = Math.min(entitled, Math.floor(rand() * (entitled * 0.7)));
      await prisma.leaveBalance.upsert({
        where: { tenantId_employeeId_leaveType_periodYear: { tenantId, employeeId: emp.id, leaveType, periodYear: year } },
        update: { entitledDays: entitled, usedDays: used },
        create: { tenantId, employeeId: emp.id, leaveType, periodYear: year, entitledDays: entitled, usedDays: used },
      });
    }
  }
  await prisma.leaveRequest.deleteMany({ where: { tenantId, reason: { startsWith: '[demo]' } } });
  const activeEmps = allEmployees.filter((e) => e.status === 'ACTIVE');
  const leaveRows = Array.from({ length: 48 }, () => {
    const emp = pick(activeEmps);
    const start = daysAgo(Math.floor(rand() * 70) - 12); // some upcoming, mostly recent past
    const days = 1 + Math.floor(rand() * 4);
    const status = weighted<LeaveRequestStatus>([['APPROVED', 62], ['PENDING', 20], ['REJECTED', 10], ['CANCELED', 8]]);
    return {
      tenantId,
      employeeId: emp.id,
      leaveType: weighted<LeaveType>([['ANNUAL', 70], ['SICK', 28], ['PATERNITY', 2]]),
      startDate: start,
      endDate: new Date(start.getTime() + (days - 1) * DAY_MS),
      days,
      reason: '[demo] seeded leave request',
      status,
      balanceApplied: status === 'APPROVED',
      decidedAt: status === 'PENDING' ? null : daysAgo(Math.floor(rand() * 10)),
    };
  });
  await prisma.leaveRequest.createMany({ data: leaveRows });

  // ---- payroll: one finalized run per branch for last month (fabricated lines) ----
  const lastMonth = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth() - 1, 1));
  for (const plan of PLANS) {
    const branchId = [...planByBranch.entries()].find(([, p]) => p === plan)![0];
    const exists = await prisma.payrollRun.findFirst({
      where: { tenantId, branchId, periodYear: lastMonth.getUTCFullYear(), periodMonth: lastMonth.getUTCMonth() + 1, runType: 'REGULAR' },
    });
    if (exists) continue;
    const branchRow = await prisma.branch.findUniqueOrThrow({ where: { id: branchId }, select: { legalEntityId: true } });
    const staff = employeesByBranch[branchId].filter((e) => e.status === 'ACTIVE' && e.joinDate < lastMonth);
    const lines = staff.map((e) => {
      const gross = plan.countryCode === 'QA' ? 9000 + Math.floor(rand() * 9000) : 4200 + Math.floor(rand() * 5200);
      const tax = plan.countryCode === 'QA' ? 0 : Math.round(gross * 0.18);
      return { e, gross, net: gross - tax, cost: Math.round(gross * 1.08) };
    });
    const run = await prisma.payrollRun.create({
      data: {
        tenantId,
        branchId,
        periodYear: lastMonth.getUTCFullYear(),
        periodMonth: lastMonth.getUTCMonth() + 1,
        status: 'FINALIZED',
        legalEntityId: branchRow.legalEntityId,
        payrollMode: 'CALCULATE',
        currencyCode: plan.currency,
        totalGross: lines.reduce((s, l) => s + l.gross, 0),
        totalNet: lines.reduce((s, l) => s + l.net, 0),
        totalEmployerCost: lines.reduce((s, l) => s + l.cost, 0),
        approvedAt: daysAgo(8),
        finalizedAt: daysAgo(6),
      },
    });
    await prisma.payrollRunLine.createMany({
      data: lines.map((l) => ({
        tenantId,
        payrollRunId: run.id,
        employeeId: l.e.id,
        branchId,
        status: 'COMPUTED' as const,
        computedVia: 'ENGINE' as const,
        grossPay: l.gross,
        netPay: l.net,
        employerCost: l.cost,
        componentBreakdown: [
          { key: 'base_salary', label: 'Base salary', type: 'EARNING', amount: String(l.gross) },
          { key: 'income_tax', label: 'Income tax', type: 'DEDUCTION', amount: String(l.gross - l.net) },
        ],
        computedAt: daysAgo(7),
      })),
    });
  }

  // ---- benefits ---------------------------------------------------------------
  const plans = [
    { code: 'DEMO_HEALTH', name: 'Demo Health Plan', benefitType: 'HEALTH_INSURANCE' as const, fixedAmount: 180, employeeSharePercent: 0.3, employerSharePercent: 0.7 },
    { code: 'DEMO_LIFE', name: 'Demo Life Cover', benefitType: 'LIFE_INSURANCE' as const, fixedAmount: 40, employeeSharePercent: 0, employerSharePercent: 1 },
  ];
  const enrollerId = adminUser?.id ?? (await prisma.user.findFirstOrThrow({ where: { tenantId } })).id;
  for (const p of plans) {
    const plan = await prisma.benefitPlan.upsert({
      where: { tenantId_code: { tenantId, code: p.code } },
      update: {},
      create: { tenantId, ...p, currencyCode: 'USD', costBasis: 'FIXED_AMOUNT', allowSelfElection: true },
    });
    for (const emp of activeEmps) {
      if (rand() > (p.code === 'DEMO_HEALTH' ? 0.75 : 0.5)) continue;
      const exists = await prisma.benefitEnrollment.findFirst({ where: { tenantId, employeeId: emp.id, planId: plan.id } });
      if (exists) continue;
      await prisma.benefitEnrollment.create({
        data: { tenantId, employeeId: emp.id, planId: plan.id, status: 'ACTIVE', effectiveFrom: daysAgo(120), enrolledByUserId: enrollerId },
      });
    }
  }

  // ---- team access users (step 7.1) -----------------------------------------
  // A few extra LOGINS with different roles so /users and the forced first-
  // login flow are testable by hand. `newhire@` is the one still holding an
  // HR-issued temporary password (mustChangePassword=true): sign in as it to
  // see the forced "set your new password" screen. Re-running re-arms it.
  const dohaBranch = await prisma.branch.findUnique({ where: { tenantId_name: { tenantId, name: 'Acme Doha Office' } } });
  const tempHash = await hash(DEMO_TEMP_PASSWORD, { algorithm: ARGON2ID });
  const teamUsers = [
    { email: 'manager@acme-demo.local', role: SYSTEM_ROLES.MANAGER, status: 'ACTIVE' as const, mustChange: false, branchId: null as string | null },
    { email: 'employee@acme-demo.local', role: SYSTEM_ROLES.EMPLOYEE, status: 'ACTIVE' as const, mustChange: false, branchId: null as string | null },
    { email: 'doha.hr@acme-demo.local', role: SYSTEM_ROLES.HR_MANAGER, status: 'ACTIVE' as const, mustChange: false, branchId: dohaBranch?.id ?? null },
    { email: 'newhire@acme-demo.local', role: SYSTEM_ROLES.EMPLOYEE, status: 'ACTIVE' as const, mustChange: true, branchId: null as string | null },
    { email: 'former.staff@acme-demo.local', role: SYSTEM_ROLES.EMPLOYEE, status: 'DISABLED' as const, mustChange: false, branchId: null as string | null },
  ];
  for (const u of teamUsers) {
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: u.role } } });
    const data = { hashedPassword: u.mustChange ? tempHash : passwordHash, status: u.status, mustChangePassword: u.mustChange };
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: u.email } },
      update: data,
      create: { tenantId, email: u.email, ...data },
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    await prisma.userBranch.deleteMany({ where: { userId: user.id } });
    if (u.branchId) await prisma.userBranch.create({ data: { tenantId, userId: user.id, branchId: u.branchId } });
  }

  // ---- hierarchical approval chain (step 7.2) ----------------------------------
  // ceo -> (top) ; pm reports to nobody => routes to the CEO ; lead -> pm ; intern -> lead.
  // Each has a linked Employee so they can submit leave from the portal, and a
  // MANAGER-rule "Leave Approval" template exists so leave actually routes via the chain.
  // Passwords: DemoPass-123!. `hr@` is HR (admin rights, can NEVER approve).
  const hqBranch = (await prisma.branch.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'Acme US HQ' } } }));
  const chain = [
    { email: 'ceo@acme-demo.local', role: SYSTEM_ROLES.CEO, name: 'Cora Executive', manager: null as string | null },
    { email: 'pm@acme-demo.local', role: SYSTEM_ROLES.MANAGER, name: 'Priya Manager', manager: null },
    { email: 'lead@acme-demo.local', role: SYSTEM_ROLES.MANAGER, name: 'Leo Teamlead', manager: 'pm@acme-demo.local' },
    { email: 'intern@acme-demo.local', role: SYSTEM_ROLES.EMPLOYEE, name: 'Ivy Intern', manager: 'lead@acme-demo.local' },
    { email: 'hr@acme-demo.local', role: SYSTEM_ROLES.HR_MANAGER, name: 'Hana Hr', manager: null },
  ];
  const chainIds = new Map<string, string>();
  for (const c of chain) {
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: c.role } } });
    const managerId = c.manager ? (chainIds.get(c.manager) ?? null) : null;
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: c.email } },
      update: { hashedPassword: passwordHash, status: 'ACTIVE', mustChangePassword: false, managerId },
      create: { tenantId, email: c.email, hashedPassword: passwordHash, status: 'ACTIVE', managerId },
    });
    chainIds.set(c.email, user.id);
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    const [firstName, lastName] = c.name.split(' ');
    const code = `CHAIN-${c.email.split('@')[0].toUpperCase()}`;
    const linked = await prisma.employee.findFirst({ where: { tenantId, userId: user.id } });
    // (7.x demo chain lives in US HQ — LTR, New York time — so Part 2/3's colourful month is easy to eyeball.)
    if (linked && linked.branchId !== hqBranch.id) await prisma.employee.update({ where: { id: linked.id }, data: { branchId: hqBranch.id } });
    if (!linked) {
      await prisma.employee.create({
        data: { tenantId, branchId: hqBranch.id, userId: user.id, employeeCode: code, firstName, lastName, employmentType: 'FULL_TIME', joinDate: daysAgo(400), status: 'ACTIVE', statutoryFields: { SSN: '000-00-0000', W4: 'on-file' } },
      });
    }
  }
  const leaveTemplate = await prisma.workflowTemplate.findFirst({ where: { tenantId, entityType: 'LeaveRequest', isActive: true } });
  if (!leaveTemplate) {
    const tpl = await prisma.workflowTemplate.create({ data: { tenantId, name: 'Leave Approval', entityType: 'LeaveRequest', version: 1, isActive: true } });
    await prisma.workflowStep.create({ data: { tenantId, templateId: tpl.id, name: 'Manager approval', order: 1, approverRule: { type: 'MANAGER' } } });
  }

  // ---- working-hours policy (step 8.1, Part 1) ---------------------------------
  // Three layers so precedence is demonstrable on /working-hours: a company
  // default (09:00, 8 work + 1 break, 15m grace), a TEAM override for the US
  // "Engineering" department (10:00 start, 10m grace), and a MEMBER override for
  // the demo intern (flexible 07:30, 7 work + 1 break, 30m grace, 4h half-day).
  // Everyone else resolves to the company default; with all three removed the
  // Country Pack's workingTime decides (US 8h, Doha 9.6h).
  const whAdmin = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId, email: 'hr@acme-demo.local' } } });
  const whUpsert = (scope: 'COMPANY' | 'TEAM' | 'MEMBER', targetKey: string, target: { departmentId?: string; employeeId?: string }, v: { startTime: string; workHours: number; breakHours: number; graceMinutes: number; halfDayThresholdHours: number | null }) =>
    prisma.workingHoursPolicy.upsert({
      where: { tenantId_scope_targetKey: { tenantId, scope, targetKey } },
      update: { ...v, updatedByUserId: whAdmin.id },
      create: { tenantId, scope, targetKey, ...target, ...v, updatedByUserId: whAdmin.id },
    });
  await whUpsert('COMPANY', 'company', {}, { startTime: '09:00', workHours: 8, breakHours: 1, graceMinutes: 15, halfDayThresholdHours: 4.5 });
  const usHq = await prisma.branch.findUnique({ where: { tenantId_name: { tenantId, name: 'Acme US HQ' } } });
  const engineering = usHq ? await prisma.department.findUnique({ where: { tenantId_branchId_name: { tenantId, branchId: usHq.id, name: 'Engineering' } } }) : null;
  if (engineering) await whUpsert('TEAM', engineering.id, { departmentId: engineering.id }, { startTime: '10:00', workHours: 8, breakHours: 1, graceMinutes: 10, halfDayThresholdHours: null });
  const internEmp = await prisma.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode: 'CHAIN-INTERN' } } });
  if (internEmp) await whUpsert('MEMBER', internEmp.id, { employeeId: internEmp.id }, { startTime: '07:30', workHours: 7, breakHours: 1, graceMinutes: 30, halfDayThresholdHours: 4 });

  // ---- shift scheduling & rostering (step 8.2) ----------------------------------
  // Three NAMED shifts (one overnight crossing midnight, one afternoon-into-night, one night),
  // STANDING assignments (US HQ Operations -> Morning, US HQ Sales -> the 16:00-01:00 shift,
  // Doha Operations -> Morning), and a DATED roster for the next two weeks with a rotation: the
  // first 7 days are PUBLISHED (employees see them), the following 7 are DRAFT (so the calendar
  // shows both states and "copy last week"/"publish" have something to do). Ivy Intern keeps her
  // MEMBER hours (member standing beats team). pm@ manages lead@ who manages the US Sales
  // people (Employee.managerId), so pm@/lead@ see a populated roster; hr@/ceo@ see everyone.
  // Idempotent: shifts/standing are upserted; the demo roster cells carry a "[demo roster]" note
  // and are deleted-and-recreated.
  {
    const shiftSpecs = [
      {
        name: 'Morning',
        startTime: '09:00',
        endTime: '17:00',
        breakMinutes: 60,
        graceMinutes: 15,
        color: '#1f8a70',
        minStaffing: 2,
      },
      {
        name: 'Sales Afternoon',
        startTime: '16:00',
        endTime: '01:00',
        breakMinutes: 60,
        graceMinutes: 15,
        color: '#c77d0a',
        minStaffing: 2,
      },
      {
        name: 'Night',
        startTime: '22:00',
        endTime: '06:00',
        breakMinutes: 30,
        graceMinutes: 10,
        color: '#4a5bd1',
        minStaffing: 1,
      },
    ];
    const shiftIds: Record<string, string> = {};
    for (const spec of shiftSpecs) {
      const [sh, sm] = spec.startTime.split(':').map(Number);
      const [eh, em] = spec.endTime.split(':').map(Number);
      const data = { ...spec, crossesMidnight: sh * 60 + sm >= eh * 60 + em };
      const row = await prisma.shiftDefinition.upsert({
        where: { tenantId_name: { tenantId, name: spec.name } },
        update: data,
        create: { tenantId, ...data },
      });
      shiftIds[spec.name] = row.id;
    }

    const standingUpsert = (departmentId: string, shiftId: string) =>
      prisma.workingHoursPolicy.upsert({
        where: { tenantId_scope_targetKey: { tenantId, scope: 'TEAM', targetKey: departmentId } },
        update: {
          shiftDefinitionId: shiftId,
          startTime: null,
          workHours: null,
          breakHours: null,
          halfDayThresholdHours: null,
          updatedByUserId: whAdmin.id,
        },
        create: {
          tenantId,
          scope: 'TEAM',
          targetKey: departmentId,
          departmentId,
          shiftDefinitionId: shiftId,
          updatedByUserId: whAdmin.id,
        },
      });
    const dohaBranch = await prisma.branch.findUnique({
      where: { tenantId_name: { tenantId, name: 'Acme Doha Office' } },
    });
    const deptOf = (branchId: string | undefined, name: string) =>
      branchId
        ? prisma.department.findUnique({
            where: { tenantId_branchId_name: { tenantId, branchId, name } },
          })
        : Promise.resolve(null);
    const [hqOps, hqSales, dohaOps] = await Promise.all([
      deptOf(usHq?.id, 'Operations'),
      deptOf(usHq?.id, 'Sales'),
      deptOf(dohaBranch?.id, 'Operations'),
    ]);
    if (hqOps) await standingUpsert(hqOps.id, shiftIds['Morning']);
    if (hqSales) await standingUpsert(hqSales.id, shiftIds['Sales Afternoon']);
    if (dohaOps) await standingUpsert(dohaOps.id, shiftIds['Morning']);

    // A shift swap approves through the real workflow engine: the manager chain.
    const swapTemplate = await prisma.workflowTemplate.findFirst({
      where: { tenantId, entityType: 'ShiftSwap', isActive: true },
    });
    if (!swapTemplate) {
      const tpl = await prisma.workflowTemplate.create({
        data: {
          tenantId,
          name: 'Shift Swap Approval',
          entityType: 'ShiftSwap',
          version: 1,
          isActive: true,
        },
      });
      await prisma.workflowStep.create({
        data: {
          tenantId,
          templateId: tpl.id,
          name: 'Manager approval',
          order: 1,
          approverRule: { type: 'MANAGER' },
        },
      });
    }

    // People: US Sales (managed by Leo Teamlead via Employee.managerId) + Doha Operations.
    const leoEmp = await prisma.employee.findUnique({
      where: { tenantId_employeeCode: { tenantId, employeeCode: 'CHAIN-LEAD' } },
    });
    const pickActive = async (departmentId: string | undefined, take: number) =>
      departmentId
        ? prisma.employee.findMany({
            where: { tenantId, departmentId, status: 'ACTIVE', userId: null },
            orderBy: { employeeCode: 'asc' },
            take,
          })
        : [];
    const salesTeam = await pickActive(hqSales?.id, 6);
    const dohaTeam = await pickActive(dohaOps?.id, 5);
    if (leoEmp && hqSales) {
      await prisma.employee.update({
        where: { id: leoEmp.id },
        data: { departmentId: hqSales.id },
      });
      for (const e of salesTeam)
        await prisma.employee.update({ where: { id: e.id }, data: { managerId: leoEmp.id } });
    }
    // The Doha HR login's own employee is rostered too, so "My schedule" is populated in RTL.
    const dohaLogin = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: 'demo.qa@acme-demo.local' } },
    });
    const dohaSelf = dohaLogin
      ? await prisma.employee.findFirst({ where: { tenantId, userId: dohaLogin.id } })
      : null;
    if (dohaSelf && dohaOps)
      await prisma.employee.update({
        where: { id: dohaSelf.id },
        data: { departmentId: dohaOps.id },
      });
    const dohaPeople = [...(dohaSelf ? [dohaSelf] : []), ...dohaTeam];
    const usPeople = [...(leoEmp ? [leoEmp] : []), ...salesTeam];

    const rosterEmployeeIds = [...usPeople, ...dohaPeople].map((e) => e.id);
    await prisma.rosterAssignment.deleteMany({
      where: { tenantId, employeeId: { in: rosterEmployeeIds }, note: '[demo roster]' },
    });

    // Two weeks starting today. Rotation: group A = Morning Mon-Fri week 1 / Sales Afternoon week 2, group B the reverse;
    // one person has a rostered mid-week day off; one covers "Night this weekend". Everyone else's weekend stays off (Country Pack).
    const cells: {
      tenantId: string;
      employeeId: string;
      shiftDefinitionId: string | null;
      dayOff: boolean;
      effectiveFrom: Date;
      effectiveTo: Date;
      status: 'DRAFT' | 'PUBLISHED';
      publishedAt: Date | null;
      createdByUserId: string;
      note: string;
    }[] = [];
    const addCell = (employeeId: string, date: Date, shift: string | null, week: number) =>
      cells.push({
        tenantId,
        employeeId,
        shiftDefinitionId: shift ? shiftIds[shift] : null,
        dayOff: shift === null,
        effectiveFrom: date,
        effectiveTo: date,
        status: week === 0 ? 'PUBLISHED' : 'DRAFT',
        publishedAt: week === 0 ? new Date() : null,
        createdByUserId: whAdmin.id,
        note: '[demo roster]',
      });
    const plan = (
      people: { id: string }[],
      weekend: number[],
      weekendNightIdx: number,
      dayOffIdx: number,
    ) => {
      for (let d = 0; d < 14; d += 1) {
        const date = new Date(todayUtc.getTime() + d * DAY_MS);
        const week = Math.floor(d / 7);
        const dow = date.getUTCDay();
        people.forEach((p, i) => {
          const isWeekend = weekend.includes(dow);
          if (isWeekend) {
            if (i === (weekendNightIdx + week) % people.length) addCell(p.id, date, 'Night', week);
            return;
          }
          if (i === dayOffIdx && dow === 3) return addCell(p.id, date, null, week);
          const groupA = i % 2 === 0;
          const morning = (groupA && week === 0) || (!groupA && week === 1);
          addCell(p.id, date, morning ? 'Morning' : 'Sales Afternoon', week);
        });
      }
    };
    plan(usPeople, [0, 6], 1, 2);
    plan(dohaPeople, [5, 6], 0, 1);
    await prisma.rosterAssignment.createMany({ data: cells });
    console.log(
      `Shift scheduling (8.2): 3 shifts, standing (US Ops/Doha Ops -> Morning, US Sales -> Sales Afternoon 16:00-01:00), ${cells.length} roster cells for ${rosterEmployeeIds.length} people (week 1 published, week 2 draft).`,
    );
  }

  // ---- a COLOURFUL month of attendance for Ivy Intern (step 8.1, Part 2) --------
  // Ivy's effective policy is her MEMBER override (07:30, 7+1 => 8h required, grace 30m,
  // half-day < 4h), New York time. One record per working day for the last ~30 days with a
  // deliberate mix so /attendance/status shows GREEN, YELLOW, RED (late beyond grace, early
  // out, half day) plus NEUTRAL (weekends, any public holiday, one approved-leave day).
  // Idempotent: her window is cleared and rewritten on every run.
  if (internEmp) {
    const tz = 'America/New_York';
    const intern = internEmp;
    const pattern = ['G', 'G', 'Y', 'G', 'R', 'G', 'G', 'Y', 'G', 'E', 'G', 'G', 'H', 'G', 'R', 'G', 'G', 'Y', 'G', 'G', 'E', 'G'];
    // [clock-in local, clock-out local] per scenario against 07:30 / 8h / grace 30 / half-day 4h.
    const scenario: Record<string, [string, string]> = {
      G: ['07:25', '15:35'], //  on time, 8h10m
      Y: ['07:50', '15:55'], //  20 min late (within the 30m grace), 8h05m
      R: ['08:35', '16:40'], //  65 min late (beyond grace), 8h05m
      E: ['07:28', '13:10'], //  left early: 5h42m of 8h
      H: ['07:30', '10:50'], //  half day: 3h20m (< 4h)
    };
    const start = new Date(todayUtc.getTime() - 32 * DAY_MS);
    await prisma.attendanceRecord.deleteMany({ where: { tenantId, employeeId: intern.id, workDate: { gte: start } } });
    await prisma.leaveRequest.deleteMany({ where: { tenantId, employeeId: intern.id, reason: '[demo] status month' } });
    let idx = 0;
    let leaveDone = false;
    for (let i = 31; i >= 1; i -= 1) {
      const d = new Date(todayUtc.getTime() - i * DAY_MS);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const kind = pattern[idx % pattern.length];
      idx += 1;
      if (idx === 9 && !leaveDone) {
        leaveDone = true; // one approved-leave weekday with NO record -> NEUTRAL / ON_LEAVE
        await prisma.leaveRequest.create({ data: { tenantId, employeeId: intern.id, leaveType: 'ANNUAL', startDate: d, endDate: d, days: 1, status: 'APPROVED', reason: '[demo] status month' } });
        continue;
      }
      const [inAt, outAt] = scenario[kind];
      await prisma.attendanceRecord.create({
        data: {
          tenantId, employeeId: intern.id, branchId: intern.branchId, workDate: d,
          clockInAt: branchLocalToUtc(d, inAt, tz), clockInSource: 'WEB',
          clockOutAt: branchLocalToUtc(d, outAt, tz), clockOutSource: 'WEB', status: 'CLOSED',
        },
      });
    }
  }

  // ---- resume screening demo (step 9.1) --------------------------------------
  // One APPROVED requisition + PUBLISHED posting with screening criteria and eight applicants whose PARSED resumes
  // differ (skills / years / education), scored by the REAL scorer — so /recruitment/screening/<requisition> shows a
  // ranked list immediately. The data is inserted already-parsed (no resume file / queue job is needed).
  const screeningCreator = adminUser ?? (await prisma.user.findFirst({ where: { tenantId } }));
  if (usHq && screeningCreator) {
    const SCREENING_TITLE = 'Senior Backend Engineer (Screening Demo)';
    const requisition =
      (await prisma.jobRequisition.findFirst({ where: { tenantId, title: SCREENING_TITLE } })) ??
      (await prisma.jobRequisition.create({
        data: { tenantId, title: SCREENING_TITLE, branchId: usHq.id, employmentType: 'FULL_TIME', headcount: 2, justification: 'Demo requisition for resume screening.', status: 'APPROVED', approvedAt: new Date(), createdByUserId: screeningCreator.id },
      }));
    const posting = await prisma.jobPosting.upsert({
      where: { tenantId_publicSlug: { tenantId, publicSlug: 'demo-senior-backend-engineer' } },
      update: {},
      create: { tenantId, requisitionId: requisition.id, title: SCREENING_TITLE, description: 'Build and scale our payments APIs (TypeScript / NestJS / PostgreSQL).', publicSlug: 'demo-senior-backend-engineer', status: 'PUBLISHED', publishedAt: new Date() },
    });
    const criteria = screeningCriteriaConfigSchema.parse({
      requiredSkills: ['TypeScript', 'NestJS', 'PostgreSQL'],
      preferredSkills: ['AWS', 'Docker', 'Kubernetes'],
      minYearsExperience: 5,
      minEducation: 'BACHELOR',
      keywordMustHaves: ['api'],
      belowThresholdScore: 50,
    });
    await prisma.screeningCriteria.upsert({
      where: { tenantId_requisitionId: { tenantId, requisitionId: requisition.id } },
      update: { config: criteria, updatedByUserId: screeningCreator.id },
      create: { tenantId, requisitionId: requisition.id, config: criteria, updatedByUserId: screeningCreator.id },
    });

    type DemoCandidate = { first: string; last: string; skills: string[]; years: number | null; level: 'HIGH_SCHOOL' | 'DIPLOMA' | 'BACHELOR' | 'MASTER' | 'DOCTORATE'; title: string; company: string; summary: string; stage?: 'APPLIED' | 'SCREEN' | 'INTERVIEW' | 'REJECTED'; failed?: boolean };
    const demoCandidates: DemoCandidate[] = [
      { first: 'Sara', last: 'Ahmed', skills: ['TypeScript', 'NestJS', 'PostgreSQL', 'AWS', 'Docker', 'Kubernetes', 'React'], years: 9, level: 'MASTER', title: 'Staff Software Engineer', company: 'Acme Payments', summary: 'Built payments APIs serving millions of requests a day.', stage: 'INTERVIEW' },
      { first: 'Daniel', last: 'Reyes', skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'React', 'Docker'], years: 6, level: 'BACHELOR', title: 'Senior Developer', company: 'Brightside', summary: 'Full-stack API development on Node.', stage: 'SCREEN' },
      { first: 'Priya', last: 'Nair', skills: ['Python', 'Django', 'PostgreSQL', 'AWS'], years: 5, level: 'BACHELOR', title: 'Backend Engineer', company: 'DataLoom', summary: 'REST API design in Python.' },
      { first: 'Omar', last: 'Haddad', skills: ['JavaScript', 'React', 'Node.js'], years: 3, level: 'BACHELOR', title: 'Web Developer', company: 'PixelWorks', summary: 'Frontend-leaning developer.' },
      { first: 'Lena', last: 'Fischer', skills: ['React', 'TypeScript', 'CSS'], years: 4, level: 'DIPLOMA', title: 'Frontend Engineer', company: 'Studio North', summary: 'Design-system focused UI engineer.' },
      { first: 'Bilal', last: 'Khan', skills: ['Python', 'Excel'], years: 1, level: 'DIPLOMA', title: 'Junior Developer', company: 'Initech', summary: 'Internal scripting and reporting.', stage: 'REJECTED' },
      { first: 'Mei', last: 'Tanaka', skills: ['Java', 'Spring Boot', 'MySQL', 'Kubernetes'], years: 12, level: 'DOCTORATE', title: 'Principal Engineer', company: 'Kaisha Systems', summary: 'Enterprise Java platform APIs.' },
      { first: 'Zed', last: 'Broken', skills: [], years: null, level: 'HIGH_SCHOOL', title: '', company: '', summary: '', failed: true },
    ];
    for (const c of demoCandidates) {
      const email = `${c.first}.${c.last}@demo-candidates.example`.toLowerCase();
      const now = new Date();
      const parsed = c.failed
        ? null
        : parsedResumeSchema.parse({
            fullName: `${c.first} ${c.last}`,
            email,
            skills: c.skills,
            experience: [{ title: c.title, company: c.company, startDate: String(now.getUTCFullYear() - Math.round(c.years ?? 0)), endDate: 'present', description: c.summary }],
            education: [{ degree: `${c.level === 'MASTER' ? 'MSc' : c.level === 'DOCTORATE' ? 'PhD' : c.level === 'BACHELOR' ? 'BSc' : 'Diploma'} in Computer Science`, level: c.level }],
            totalYearsExperience: c.years,
            links: [],
            summary: c.summary,
            rawText: `${c.first} ${c.last} ${c.title} ${c.company} ${c.summary} ${c.skills.join(' ')}`,
          });
      const candidateData = {
        firstName: c.first,
        lastName: c.last,
        source: 'demo',
        parseStatus: parsed ? ('PARSED' as const) : ('FAILED' as const),
        parsedData: parsed ?? undefined,
        parseError: parsed ? null : 'Unsupported file type — please upload a PDF, DOCX or TXT resume.',
        parserName: parsed ? 'demo-seed' : 'built-in-heuristic-v1',
        parsedAt: parsed ? now : null,
      };
      const candidate = await prisma.candidate.upsert({
        where: { tenantId_email: { tenantId, email } },
        update: candidateData,
        create: { tenantId, email, ...candidateData },
      });
      const result = parsed ? scoreResume({ parsed, config: criteria, basedOnEditedData: false }) : null;
      const screening = {
        screeningScore: result?.score ?? null,
        screeningResult: result ? (result as unknown as object) : undefined,
        belowThreshold: result?.belowThreshold ?? false,
        screenedAt: result ? now : null,
      };
      await prisma.application.upsert({
        where: { tenantId_candidateId_jobPostingId: { tenantId, candidateId: candidate.id, jobPostingId: posting.id } },
        update: { ...screening, stage: c.stage ?? 'APPLIED' },
        create: { tenantId, candidateId: candidate.id, jobPostingId: posting.id, stage: c.stage ?? 'APPLIED', ...screening },
      });
    }
    console.log(`Resume screening demo: requisition "${SCREENING_TITLE}" (id ${requisition.id}) -> portal /recruitment/screening/${requisition.id} (sign in as hr@acme-demo.local or ceo@).`);
  }

  // ---- kiosk mode (step 11.1) ---------------------------------------------------
  // One shared terminal at Acme US HQ with a FIXED, documented device token so the screen is demonstrable
  // immediately (a real token is random and shown once). Three HQ employees get fixed PINs. This token is
  // for the LOCAL DEMO tenant only — never seed a known token anywhere real.
  if (usHq) {
    const kioskTokenPrefix = DEMO_KIOSK_TOKEN.slice(0, 16);
    const kioskData = { tenantId, branchId: usHq.id, name: 'US HQ Front Desk', status: 'ACTIVE' as const, revokedAt: null, requirePhoto: false, hashedToken: await hash(DEMO_KIOSK_TOKEN, { algorithm: ARGON2ID }) };
    await prisma.kiosk.upsert({ where: { tokenPrefix: kioskTokenPrefix }, update: kioskData, create: { ...kioskData, tokenPrefix: kioskTokenPrefix, createdByUserId: whAdmin.id } });
    for (const [code, pin] of Object.entries(DEMO_KIOSK_PINS)) {
      const emp = await prisma.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode: code } } });
      if (!emp) continue;
      const pinHash = await hash(pin, { algorithm: ARGON2ID });
      await prisma.employeeKioskPin.upsert({ where: { tenantId_employeeId: { tenantId, employeeId: emp.id } }, update: { pinHash, lastUsedAt: null }, create: { tenantId, employeeId: emp.id, pinHash, issuedByUserId: whAdmin.id } });
    }
    console.log(`Kiosk (11.1): open http://localhost:3003/kiosk#token=${DEMO_KIOSK_TOKEN}  — employee ID + PIN: ${Object.entries(DEMO_KIOSK_PINS).map(([c, p]) => `${c}/${p}`).join(', ')}. Manage at /kiosks (hr@ or ceo@).`);
  }

  // ---- engagement & culture (step 10.1) ----------------------------------------------
  // Recognition categories + a few recognitions (some PUBLIC -> feed posts), a company feed
  // (announcements, a team-scoped post, celebrations, reactions, comments) and two surveys: an OPEN
  // identified "pulse" with two responses and an OPEN ANONYMOUS one with three (so its aggregates are
  // above the anonymity threshold). Every row has a FIXED id so a re-run refreshes instead of
  // duplicating; balances/tallies are recomputed from the rows. Sign in as hr@ / ceo@ (admin),
  // pm@ / lead@ / intern@ (employees) or demo.qa@ (Doha, Arabic RTL). See docs/conventions/engagement-culture.md.
  {
    const eid = (n: number) => `00000000-0000-4000-8000-${String(900000000000 + n)}`; // fixed demo row ids
    const userOf = (email: string) => prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId, email } } });
    const empOf = async (email: string) => {
      const u = await userOf(email);
      return prisma.employee.findFirstOrThrow({ where: { tenantId, userId: u.id } });
    };
    const [ceo, pm, lead, intern, hrE, qa] = await Promise.all(['ceo@', 'pm@', 'lead@', 'intern@', 'hr@', 'demo.qa@'].map((x) => empOf(`${x}acme-demo.local`)));
    const hrUser = await userOf('hr@acme-demo.local');
    const sample = allEmployees.filter((e) => e.status === 'ACTIVE' && !e.code.startsWith('CHAIN')).slice(0, 8);
    const sampleEmps = await prisma.employee.findMany({ where: { id: { in: sample.map((e) => e.id) } } });

    // categories (tenant DATA)
    const catDefs = [
      { name: 'Teamwork', description: 'Pitching in and lifting the team', points: 5 },
      { name: 'Going above & beyond', description: 'Exceptional effort', points: 10 },
      { name: 'Customer focus', description: 'Putting customers first', points: 5 },
      { name: 'Innovation', description: 'New ideas that move us forward', points: 8 },
      { name: 'Mentorship', description: 'Helping others grow', points: 3 },
    ];
    const cat: Record<string, string> = {};
    for (const c of catDefs) {
      const row = await prisma.recognitionCategory.upsert({ where: { tenantId_name: { tenantId, name: c.name } }, update: { description: c.description, points: c.points, isActive: true }, create: { tenantId, ...c } });
      cat[c.name] = row.id;
    }

    // recognitions (fixed ids; dates spread over the last ~3 weeks)
    const recs = [
      { n: 1, giver: lead, to: [intern], cat: 'Teamwork', vis: 'PUBLIC' as const, ago: 1, msg: 'Ivy jumped in to finish the release checklist after hours — thank you!' },
      { n: 2, giver: pm, to: [lead], cat: 'Going above & beyond', vis: 'PUBLIC' as const, ago: 2, msg: 'Leo untangled the migration weekend and kept everyone calm. Huge.' },
      { n: 3, giver: ceo, to: [pm, lead], cat: 'Innovation', vis: 'PUBLIC' as const, ago: 4, msg: 'The new onboarding flow cut setup time in half. Brilliant work from you both.' },
      { n: 4, giver: hrE, to: [qa], cat: 'Customer focus', vis: 'PUBLIC' as const, ago: 6, msg: 'Thank you for handling the Doha client escalation with such care.' },
      { n: 5, giver: lead, to: [intern], cat: 'Mentorship', vis: 'PRIVATE' as const, ago: 3, msg: 'Quietly proud of how fast you are growing. Keep going.' },
      { n: 6, giver: intern, to: [lead], cat: 'Mentorship', vis: 'PUBLIC' as const, ago: 9, msg: 'Leo always makes time to explain the "why". Great mentor.' },
      ...(sampleEmps.length >= 6
        ? [
            { n: 7, giver: sampleEmps[0], to: [sampleEmps[1], sampleEmps[2]], cat: 'Teamwork', vis: 'PUBLIC' as const, ago: 12, msg: 'You two carried the quarter-end close. Thank you!' },
            { n: 8, giver: sampleEmps[3], to: [sampleEmps[4]], cat: 'Customer focus', vis: 'PUBLIC' as const, ago: 15, msg: 'Fantastic support call — the customer sent a thank-you note.' },
            { n: 9, giver: sampleEmps[5], to: [sampleEmps[1]], cat: 'Going above & beyond', vis: 'PUBLIC' as const, ago: 18, msg: 'Stayed late to fix the payroll export. Legend.' },
          ]
        : []),
    ];
    for (const r of recs) {
      const when = new Date(todayUtc.getTime() - r.ago * DAY_MS + 10 * 3600_000);
      const id = eid(100 + r.n);
      const points = catDefs.find((c) => c.name === r.cat)!.points;
      await prisma.recognition.upsert({
        where: { id },
        update: { message: r.msg, visibility: r.vis, createdAt: when, removedAt: null },
        create: { id, tenantId, giverEmployeeId: r.giver.id, categoryId: cat[r.cat], message: r.msg, visibility: r.vis, createdAt: when },
      });
      for (const to of r.to) {
        await prisma.recognitionRecipient.upsert({
          where: { recognitionId_recipientEmployeeId: { recognitionId: id, recipientEmployeeId: to.id } },
          update: { points, occurredAt: when, removedAt: null },
          create: { tenantId, recognitionId: id, recipientEmployeeId: to.id, categoryId: cat[r.cat], points, occurredAt: when },
        });
      }
      if (r.vis === 'PUBLIC') {
        const giverUser = r.giver.userId;
        await prisma.feedPost.upsert({
          where: { recognitionId: id },
          update: { createdAt: when, removedAt: null },
          create: { tenantId, type: 'RECOGNITION', scopeType: 'ORG', authorUserId: giverUser, body: r.msg, recognitionId: id, createdAt: when },
        });
      }
    }
    // balances recomputed from the rows (the running tally)
    const grouped = await prisma.recognitionRecipient.groupBy({ by: ['recipientEmployeeId'], where: { tenantId, removedAt: null }, _sum: { points: true }, _count: { _all: true } });
    for (const g of grouped) {
      await prisma.recognitionBalance.upsert({
        where: { tenantId_employeeId: { tenantId, employeeId: g.recipientEmployeeId } },
        update: { totalPoints: g._sum.points ?? 0, receivedCount: g._count._all },
        create: { tenantId, employeeId: g.recipientEmployeeId, totalPoints: g._sum.points ?? 0, receivedCount: g._count._all },
      });
    }

    // company feed: announcements, a team-scoped post, celebrations
    const engDept = await prisma.department.findFirst({ where: { tenantId, branchId: hqBranch.id, name: 'Engineering' } });
    await prisma.employee.update({ where: { id: lead.id }, data: { dateOfBirth: new Date(Date.UTC(1988, todayUtc.getUTCMonth(), todayUtc.getUTCDate())) } });
    const year = todayUtc.getUTCFullYear();
    const posts = [
      { n: 201, type: 'ANNOUNCEMENT' as const, scopeType: 'ORG' as const, scopeId: null as string | null, title: 'Welcome to the Engagement hub', body: 'Recognize a colleague, answer the Q4 pulse survey and keep an eye on this feed for company news. 🎉', pinned: true, ago: 0 },
      { n: 202, type: 'ANNOUNCEMENT' as const, scopeType: 'ORG' as const, scopeId: null, title: 'Town hall this Friday', body: 'Join us at 3pm for the quarterly town hall — questions welcome in the comments.', pinned: false, ago: 2 },
      ...(engDept ? [{ n: 203, type: 'ANNOUNCEMENT' as const, scopeType: 'DEPARTMENT' as const, scopeId: engDept.id as string | null, title: 'Engineering offsite', body: 'Engineering offsite next month — details coming. (Visible to the Engineering team only.)', pinned: false, ago: 1 }] : []),
    ];
    for (const p of posts) {
      const when = new Date(todayUtc.getTime() - p.ago * DAY_MS + 9 * 3600_000);
      await prisma.feedPost.upsert({
        where: { id: eid(p.n) },
        update: { title: p.title, body: p.body, pinned: p.pinned, createdAt: when, removedAt: null },
        create: { id: eid(p.n), tenantId, type: p.type, scopeType: p.scopeType, scopeId: p.scopeId, authorUserId: hrUser.id, title: p.title, body: p.body, pinned: p.pinned, createdAt: when },
      });
    }
    const celebrations = [
      { n: 211, kind: 'BIRTHDAY' as const, subject: lead, key: `BIRTHDAY:${lead.id}:${year}`, meta: undefined },
      { n: 212, kind: 'WORK_ANNIVERSARY' as const, subject: pm, key: `WORK_ANNIVERSARY:${pm.id}:${year}`, meta: { years: 1 } },
      { n: 213, kind: 'NEW_JOINER' as const, subject: intern, key: `NEW_JOINER:${intern.id}`, meta: undefined },
    ];
    for (const c of celebrations) {
      await prisma.feedPost.upsert({
        where: { tenantId_celebrationKey: { tenantId, celebrationKey: c.key } },
        update: { removedAt: null },
        create: { id: eid(c.n), tenantId, type: 'CELEBRATION', scopeType: 'ORG', body: '', celebrationKind: c.kind, subjectEmployeeId: c.subject.id, celebrationKey: c.key, meta: c.meta, createdAt: new Date(todayUtc.getTime() + 6 * 3600_000) },
      });
    }

    // reactions + comments
    const reactors = await Promise.all(['pm@', 'lead@', 'intern@', 'ceo@', 'hr@'].map((x) => userOf(`${x}acme-demo.local`)));
    const reactTargets = [eid(201), eid(202), eid(211), eid(212), eid(213)];
    const firstRec = await prisma.feedPost.findMany({ where: { tenantId, type: 'RECOGNITION', recognitionId: { in: recs.map((r) => eid(100 + r.n)) } }, select: { id: true }, take: 3 });
    for (const [i, postId] of [...reactTargets, ...firstRec.map((x) => x.id)].entries()) {
      for (const [j, u] of reactors.entries()) {
        if ((i + j) % 3 === 2) continue; // not everyone reacts to everything
        await prisma.feedReaction.upsert({
          where: { postId_userId: { postId, userId: u.id } },
          update: {},
          create: { tenantId, postId, userId: u.id, type: (i + j) % 2 === 0 ? 'CELEBRATE' : 'LIKE' },
        });
      }
    }
    const commentDefs = [
      { n: 301, post: eid(202), by: 'intern@', text: 'Looking forward to it!' },
      { n: 302, post: eid(211), by: 'pm@', text: 'Happy birthday, Leo! 🎂' },
      { n: 303, post: eid(213), by: 'lead@', text: 'Welcome aboard, Ivy!' },
      { n: 304, post: eid(212), by: 'ceo@', text: 'Thank you for a great year, Priya.' },
    ];
    for (const c of commentDefs) {
      const u = await userOf(`${c.by}acme-demo.local`);
      await prisma.feedComment.upsert({ where: { id: eid(c.n) }, update: { removedAt: null }, create: { id: eid(c.n), tenantId, postId: c.post, authorUserId: u.id, body: c.text } });
    }

    // surveys — recreated from fixed ids (cascade drops questions/assignments/responses/tallies)
    await prisma.survey.deleteMany({ where: { id: { in: [eid(401), eid(402)] } } });
    const orgUsers = await prisma.employee.findMany({ where: { tenantId, status: 'ACTIVE', userId: { not: null } }, select: { userId: true } });
    const assignees = orgUsers.map((e) => e.userId as string);
    const mkSurvey = async (n: number, title: string, description: string, anonymous: boolean, qs: { type: 'RATING' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'TEXT'; prompt: string; required?: boolean; scaleMin?: number; scaleMax?: number; options?: { id: string; label: string }[] }[]) => {
      const surveyId = eid(n);
      await prisma.survey.create({
        data: { id: surveyId, tenantId, title, description, anonymous, status: 'OPEN', audienceType: 'ORG', audienceIds: [], opensAt: daysAgo(2), closesAt: new Date(todayUtc.getTime() + 14 * DAY_MS), createdByUserId: hrUser.id, publishedAt: daysAgo(2), assignedCount: assignees.length, responseCount: 0 },
      });
      const questions: { id: string; type: string; scaleMin: number | null; scaleMax: number | null; options: { id: string }[] | null }[] = [];
      for (const [i, q] of qs.entries()) {
        const row = await prisma.surveyQuestion.create({ data: { id: eid(n * 10 + i + 1), tenantId, surveyId, order: i + 1, type: q.type, prompt: q.prompt, required: q.required ?? true, scaleMin: q.type === 'RATING' ? (q.scaleMin ?? 1) : null, scaleMax: q.type === 'RATING' ? (q.scaleMax ?? 5) : null, options: q.options } });
        questions.push({ id: row.id, type: q.type, scaleMin: row.scaleMin, scaleMax: row.scaleMax, options: q.options ?? null });
        if (q.type === 'RATING') for (let v = row.scaleMin!; v <= row.scaleMax!; v += 1) await prisma.surveyTally.create({ data: { tenantId, surveyId, questionId: row.id, bucket: String(v) } });
        if (q.options) for (const o of q.options) await prisma.surveyTally.create({ data: { tenantId, surveyId, questionId: row.id, bucket: o.id } });
      }
      await prisma.surveyAssignment.createMany({ data: assignees.map((userId) => ({ tenantId, surveyId, userId })) });
      return { surveyId, questions };
    };
    // Mirrors SurveyResponseService.submit: an anonymous survey stores NO respondent id.
    const respond = async (s: { surveyId: string; questions: { id: string; type: string; options: { id: string }[] | null }[] }, anonymous: boolean, userId: string, answers: Record<number, number | string | string[]>) => {
      await prisma.surveyAssignment.updateMany({ where: { surveyId: s.surveyId, userId }, data: { status: 'SUBMITTED', submittedOn: todayUtc } });
      const response = await prisma.surveyResponse.create({ data: { tenantId, surveyId: s.surveyId, respondentUserId: anonymous ? null : userId, submittedOn: todayUtc } });
      for (const [idx, value] of Object.entries(answers)) {
        const q = s.questions[Number(idx)];
        if (q.type === 'RATING') {
          await prisma.surveyAnswer.create({ data: { tenantId, responseId: response.id, surveyId: s.surveyId, questionId: q.id, ratingValue: value as number } });
          await prisma.surveyTally.updateMany({ where: { surveyId: s.surveyId, questionId: q.id, bucket: String(value) }, data: { count: { increment: 1 } } });
        } else if (q.type === 'TEXT') {
          await prisma.surveyAnswer.create({ data: { tenantId, responseId: response.id, surveyId: s.surveyId, questionId: q.id, textValue: value as string } });
        } else {
          const ids = Array.isArray(value) ? value : [value as string];
          await prisma.surveyAnswer.create({ data: { tenantId, responseId: response.id, surveyId: s.surveyId, questionId: q.id, optionIds: ids } });
          for (const id of ids) await prisma.surveyTally.updateMany({ where: { surveyId: s.surveyId, questionId: q.id, bucket: id }, data: { count: { increment: 1 } } });
        }
      }
      await prisma.survey.update({ where: { id: s.surveyId }, data: { responseCount: { increment: 1 } } });
    };
    const perks = [{ id: 'remote', label: 'Remote work' }, { id: 'gym', label: 'Gym membership' }, { id: 'learning', label: 'Learning budget' }];
    const pulse = await mkSurvey(401, 'Q4 Engagement Pulse', 'A quick check-in on how work feels right now. Takes 2 minutes. (Identified — your name is recorded with your answers.)', false, [
      { type: 'RATING', prompt: 'How satisfied are you working here? (1 = not at all, 5 = extremely)' },
      { type: 'RATING', prompt: 'How likely are you to recommend us as a place to work? (1–10)', scaleMin: 1, scaleMax: 10 },
      { type: 'SINGLE_CHOICE', prompt: 'Which perk matters most to you?', options: perks },
      { type: 'MULTI_CHOICE', prompt: 'Which of these would help you do your best work?', required: false, options: [{ id: 'focus', label: 'More focus time' }, { id: 'tools', label: 'Better tools' }, { id: 'clarity', label: 'Clearer priorities' }] },
      { type: 'TEXT', prompt: 'Anything we should start, stop or continue?', required: false },
    ]);
    await respond(pulse, false, (await userOf('intern@acme-demo.local')).id, { 0: 4, 1: 8, 2: 'learning', 3: ['focus', 'clarity'], 4: 'Continue the mentoring — it makes a real difference.' });
    await respond(pulse, false, (await userOf('lead@acme-demo.local')).id, { 0: 5, 1: 9, 2: 'remote', 3: ['tools'], 4: 'Start: a monthly demo day.' });
    const anon = await mkSurvey(402, 'Anonymous culture check', 'Candid, anonymous feedback. Your name is NOT stored with your answers.', true, [
      { type: 'RATING', prompt: 'I feel comfortable raising concerns with my manager.' },
      { type: 'RATING', prompt: 'Decisions here are communicated clearly.' },
      { type: 'TEXT', prompt: 'What is one thing leadership should hear?', required: false },
    ]);
    await respond(anon, true, (await userOf('pm@acme-demo.local')).id, { 0: 5, 1: 4, 2: 'More visibility into roadmap trade-offs, please.' });
    await respond(anon, true, (await userOf('ceo@acme-demo.local')).id, { 0: 4, 1: 4 });
    await respond(anon, true, (await userOf('hr@acme-demo.local')).id, { 0: 3, 1: 3, 2: 'Meetings run long; tighter agendas would help.' });
    console.log('Engagement demo (10.1): recognition + feed at /recognition and /feed, surveys at /surveys (employees) and /engagement (hr@ / ceo@ admin: overview, survey results, categories, moderation). Two open surveys: "Q4 Engagement Pulse" (identified, 2 responses) and "Anonymous culture check" (anonymous, 3 responses).');
  }

  // ---- extra demo tenants + subscriptions (vendor-console charts) -------------
  const extra = [
    { slug: 'demo-globex', name: 'Globex Industries (demo)', edition: 'ENTERPRISE' as const, status: 'ACTIVE' as const, sub: 'ACTIVE' as const, seats: 250, ago: 160, country: 'US' },
    { slug: 'demo-initech', name: 'Initech Software (demo)', edition: 'PROFESSIONAL' as const, status: 'ACTIVE' as const, sub: 'PAST_DUE' as const, seats: 60, ago: 95, country: 'US' },
    { slug: 'demo-qatar-logistics', name: 'Gulf Logistics (demo)', edition: 'PROFESSIONAL' as const, status: 'ACTIVE' as const, sub: 'ACTIVE' as const, seats: 120, ago: 40, country: 'QA' },
    { slug: 'demo-startup', name: 'Tiny Startup (demo)', edition: 'STARTER' as const, status: 'TRIAL' as const, sub: 'TRIAL' as const, seats: 15, ago: 9, country: 'US' },
    { slug: 'demo-umbrella', name: 'Umbrella Retail (demo)', edition: 'STARTER' as const, status: 'SUSPENDED' as const, sub: 'CANCELED' as const, seats: 30, ago: 200, country: 'US' },
  ];
  for (const x of extra) {
    const t = await prisma.tenant.upsert({
      where: { slug: x.slug },
      update: {},
      create: { name: x.name, slug: x.slug, status: x.status, edition: x.edition, defaultCountryCode: x.country, hostingRegion: 'us-east-1', createdAt: daysAgo(x.ago) },
    });
    await prisma.subscription.upsert({
      where: { tenantId: t.id },
      update: {},
      create: { tenantId: t.id, edition: x.edition, status: x.sub, seatCap: x.seats, quantity: Math.round(x.seats * 0.8), currentPeriodEnd: new Date(todayUtc.getTime() + (5 + Math.floor(rand() * 25)) * DAY_MS), cancelAtPeriodEnd: x.sub === 'CANCELED' },
    });
  }

  const active = allEmployees.filter((e) => e.status === 'ACTIVE').length;
  console.log(`Demo data ready for "${TENANT_SLUG}": ${allEmployees.length} employees (${active} active), ${summaryRows.length} attendance summaries, ${leaveRows.length} leave requests, ${extra.length} extra demo tenants.`);
  console.log('Demo logins (password for both:', `${DEMO_PASSWORD}):`);
  for (const l of demoLogins) console.log(`  ${l.email}  — ${l.branch}`);
  console.log('Approval chain (step 7.2), password', DEMO_PASSWORD + ': intern@ -> lead@ -> pm@ -> (top) -> ceo@acme-demo.local ; hr@acme-demo.local is HR (never approves).');
  console.log('Attendance status (Part 2): intern@acme-demo.local has ~30 days of mixed GREEN/YELLOW/RED/NEUTRAL days — GET /attendance/status?from&to (US HQ, New York time).');
  console.log('Live clock + monthly graph (Part 3): sign in as intern@acme-demo.local -> /dashboard & /attendance. For a RUNNING clock: pnpm --filter @hrm/api run demo:clock-in [email] [hoursAgo]  (e.g. intern@acme-demo.local 3).');
  console.log('Working hours (/working-hours, sign in as hr@acme-demo.local or ceo@): company 09:00 8+1; Engineering (US HQ) team 10:00; Ivy Intern member 07:30 7+1.');
  console.log('Shift scheduling (8.2): sign in as pm@ / lead@ (manager: /scheduling shows their reports), hr@ or ceo@ (everyone, define shifts) or demo.qa@acme-demo.local (Doha, Arabic RTL — also has "My schedule"); employees see /schedule.');
  console.log('Team-access demo users (/users):');
  for (const u of teamUsers) console.log(`  ${u.email}  — ${u.role}${u.status === 'DISABLED' ? ' (deactivated)' : ''}${u.mustChange ? ` — MUST CHANGE PASSWORD, temp password: ${DEMO_TEMP_PASSWORD}` : `, password: ${DEMO_PASSWORD}`}`);
  console.log('Next: pnpm --filter @hrm/api run demo:rollup');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
