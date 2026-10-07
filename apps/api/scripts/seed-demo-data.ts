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
import type { AttendanceDayStatus, EmploymentType, Gender, LeaveRequestStatus, LeaveType } from '@hrm/db';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const TENANT_SLUG = 'acme-demo';
const DEMO_PASSWORD = 'DemoPass-123!';
/** The one-time temporary password of the demo user that is mid-onboarding (mustChangePassword=true) — see the "team access" section below. */
const DEMO_TEMP_PASSWORD = 'Temp-Pass-123!';
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
  const hqBranch = (await prisma.branch.findFirst({ where: { tenantId }, orderBy: { name: 'asc' } }))!;
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
