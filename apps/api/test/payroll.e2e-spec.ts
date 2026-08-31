/**
 * Proves the Payroll module (step 2.1, Phase 2's first step) end to end
 * over real HTTP — see docs/conventions/payroll.md: THE highest-risk
 * module in this codebase, so the emphasis here is real, hand-computed
 * numbers, not just "a response came back 200". The central proof: the
 * SAME `PayrollEngineService` code produces a correct US run
 * (federal+state+FICA, annualize/de-annualize against 0.5's existing
 * PROGRESSIVE_BRACKETS/FLAT_RATE math) and a correct Qatar run (zero
 * income tax, a tiered end-of-service gratuity correctly reported as an
 * INCREMENTAL monthly accrual, not the cumulative lifetime total) from
 * the two EXISTING reference Country Packs, with zero country-code
 * branches anywhere in this module.
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
import type { CountryPackConfig } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { PAYROLL_RUN_ENTITY_TYPE } from '../src/payroll/payroll.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'payroll-test-tenant-a';
const TENANT_B_SLUG = 'payroll-test-tenant-b';
const DELEGATE_COUNTRY_CODE = 'ZZ';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

const DELEGATE_PACK_CONFIG: CountryPackConfig = {
  locale: { currencyCode: 'ZZZ', currencySymbol: 'Z', numberFormat: 'en-US', dateFormat: 'MM/DD/YYYY', defaultLanguage: 'en', rtl: false, firstDayOfWeek: 'SUNDAY' },
  workingTime: { standardWeeklyHours: 40, weekendDays: ['SATURDAY', 'SUNDAY'], overtimeRules: { multiplier: 1.5 } },
  leaveDefaults: { annualDays: 0, sickDays: 0, maternityDays: 0, paternityDays: 0 },
  publicHolidays: {},
  tax: { layers: [] },
  statutory: { components: [] },
  requiredEmployeeFields: [],
  payslipTemplate: { language: 'en', lineItems: [{ key: 'gross', label: 'Gross' }, { key: 'net', label: 'Net' }] },
  payrollMode: 'DELEGATE',
  hostingRegionHint: 'us-east-1',
};

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  await prisma.countryPack.deleteMany({ where: { countryCode: DELEGATE_COUNTRY_CODE } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 200): Promise<T> {
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

describe('payroll (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchUsId: string;
  let branchQaId: string;
  let branchDelegateId: string;

  let tokenAdminA: string;
  let tokenHrNoSalaryViewA: string;
  let tokenAdminB: string;

  let usEmployeeId: string;
  let usEmployeeUserId: string;
  let usControlEmployeeId: string;
  let qaEmployeeId: string;
  let qaEmployeeUserId: string;
  let delegateEmployeeId: string;
  let brokenEmployeeId: string;

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  /** Reliably buffers a binary/text file response (PDF, CSV) as a real `Buffer` — superagent's default per-content-type body parsing isn't guaranteed to do this, the SAME `.buffer(true).parse(...)` pattern `employees.e2e-spec.ts`'s document-download test already establishes. */
  function download(method: 'get' | 'post', path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      [method](path)
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  async function makeEmployee(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    return prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `PR-${Math.random().toString(36).slice(2, 8)}`,
        firstName: 'Test',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    // The DELEGATE-mode proof pack — deliberately NOT added to
    // seed-country-packs.ts (0.5's own file, off-limits to this step) —
    // created directly the same way every other e2e suite creates
    // test-specific fixtures.
    await prisma.countryPack.create({ data: { countryCode: DELEGATE_COUNTRY_CODE, version: 1, isActive: true, config: DELEGATE_PACK_CONFIG } });
    await prisma.exchangeRate.upsert({
      where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency: 'QAR', quoteCurrency: 'USD', asOfDate: new Date('2026-01-01') } },
      update: { rate: '0.2747' },
      create: { baseCurrency: 'QAR', quoteCurrency: 'USD', rate: '0.2747', asOfDate: new Date('2026-01-01') },
    });
    // The DELEGATE-mode test pack's fictitious currency also needs a rate
    // into the tenant's base currency — every run's multi-currency rollup
    // step resolves one unconditionally, DELEGATE mode included (see
    // docs/conventions/payroll.md's "no missing_ok" note on
    // `ExchangeRateService`).
    await prisma.exchangeRate.upsert({
      where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency: 'ZZZ', quoteCurrency: 'USD', asOfDate: new Date('2026-01-01') } },
      update: { rate: '1.0' },
      create: { baseCurrency: 'ZZZ', quoteCurrency: 'USD', rate: '1.0', asOfDate: new Date('2026-01-01') },
    });

    const tenantA = await prisma.tenant.create({
      data: { name: 'Payroll Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', baseCurrencyCode: 'USD' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Payroll Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // Unlocks `multi_country_payroll` (ENTERPRISE-only per EDITION_FEATURES)
    // for both tenants via the SAME per-tenant admin lever 0.6 already
    // built — no Subscription row needed.
    for (const tenantId of [tenantAId, tenantBId]) {
      await prisma.tenantFeatureFlagOverride.create({ data: { tenantId, flagKey: 'multi_country_payroll', enabled: true } });
    }

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchUs = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Payroll A US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchUsId = branchUs.id;
    const branchQa = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Payroll A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } });
    branchQaId = branchQa.id;
    const branchDelegate = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Payroll A Delegate Branch', countryCode: DELEGATE_COUNTRY_CODE, timezone: 'UTC' } });
    branchDelegateId = branchDelegate.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const noSalaryViewRole = await prisma.role.create({ data: { tenantId: tenantAId, name: 'PAYROLL_NO_SALARY_VIEW', isSystem: false } });
    const payrollRunPermission = await prisma.permission.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenantAId, key: 'payroll.run' } } });
    await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: noSalaryViewRole.id, permissionId: payrollRunPermission.id } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@payroll-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const noSalaryUser = await makeUserWithRole(tenantAId, noSalaryViewRole.id, 'no-salary-view@payroll-a.test');
    tokenHrNoSalaryViewA = jwt.sign({ sub: noSalaryUser.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@payroll-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // US employee — used for the divergence + overtime/unpaid-leave proof.
    const usUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'us-employee@payroll-a.test');
    usEmployeeUserId = usUser.id;
    const usEmployee = await makeEmployee(tenantAId, branchUsId, { userId: usUser.id, joinDate: new Date('2018-01-01') });
    usEmployeeId = usEmployee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${usEmployeeId}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary: 6000, salaryCurrency: 'USD' }, bankDetails: { accountNumber: '000123456', bankName: 'First Test Bank' } })
      .expect(200);

    // A control employee on the same branch with NO attendance data at all — proves overtime/unpaid-leave adjustments are per-employee, not branch-wide.
    const usControl = await makeEmployee(tenantAId, branchUsId, { joinDate: new Date('2018-01-01') });
    usControlEmployeeId = usControl.id;
    await request(app.getHttpServer())
      .patch(`/employees/${usControlEmployeeId}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary: 6000, salaryCurrency: 'USD' } })
      .expect(200);

    // QA employee — 3 years of service as of the test period, for a clean, non-tier-boundary-crossing gratuity delta.
    const qaUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'qa-employee@payroll-a.test');
    qaEmployeeUserId = qaUser.id;
    const qaEmployee = await makeEmployee(tenantAId, branchQaId, { userId: qaUser.id, joinDate: new Date('2023-06-01') });
    qaEmployeeId = qaEmployee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${qaEmployeeId}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary: 9000, salaryCurrency: 'QAR' } })
      .expect(200);

    const delegateEmployee = await makeEmployee(tenantAId, branchDelegateId, {});
    delegateEmployeeId = delegateEmployee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${delegateEmployeeId}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary: 4000, salaryCurrency: 'ZZZ' } })
      .expect(200);

    // Attendance for the June 2026 period: 120 overtime minutes + one ABSENT day for usEmployee.
    await prisma.attendanceDailySummary.createMany({
      data: [
        { tenantId: tenantAId, employeeId: usEmployeeId, branchId: branchUsId, workDate: new Date('2026-06-05'), status: 'PRESENT', overtimeMinutes: 60, workedMinutes: 540 },
        { tenantId: tenantAId, employeeId: usEmployeeId, branchId: branchUsId, workDate: new Date('2026-06-08'), status: 'PRESENT', overtimeMinutes: 60, workedMinutes: 540 },
        { tenantId: tenantAId, employeeId: usEmployeeId, branchId: branchUsId, workDate: new Date('2026-06-10'), status: 'ABSENT' },
      ],
    });

    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Payroll Run Approval', entityType: PAYROLL_RUN_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: template.id, name: 'Admin approval', order: 1, approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN } },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  let usRunId: string;
  let qaRunId: string;
  let delegateRunId: string;

  describe('CALCULATE mode — the same engine, opposite results from the two reference packs', () => {
    it('a US-branch run computes federal+state+FICA correctly, including overtime pay and an unpaid-leave deduction', async () => {
      const createRes = await post('/payroll/runs', tokenAdminA, { branchId: branchUsId, periodYear: 2026, periodMonth: 6 }).expect(201);
      usRunId = createRes.body.id;
      await post(`/payroll/runs/${usRunId}/calculate`, tokenAdminA, {}).expect(201);

      const run = await waitFor(async () => {
        const res = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
        return res.body.status === 'CALCULATED' ? res.body : null;
      });

      const mainLine = run.lines.find((l: { employeeId: string }) => l.employeeId === usEmployeeId);
      const controlLine = run.lines.find((l: { employeeId: string }) => l.employeeId === usControlEmployeeId);

      // Control: no attendance data at all -> gross === basic, no overtime/unpaid lines.
      expect(Number(controlLine.grossPay)).toBeCloseTo(6000, 2);
      const controlBreakdown = controlLine.componentBreakdown as { key: string }[];
      expect(controlBreakdown.some((c) => c.key === 'overtime')).toBe(false);
      expect(controlBreakdown.some((c) => c.key === 'unpaid_leave')).toBe(false);

      // Main employee: basic 6000, 1 unpaid day (22 working days in June 2026, no US holiday that month),
      // 120 overtime minutes at 1.5x. dailyRate = 6000/22; hourlyRate = (6000*12)/(40*52).
      const dailyRate = 6000 / 22;
      const unpaidDeduction = Math.round(dailyRate * 1 * 100) / 100;
      const hourlyRate = (6000 * 12) / (40 * 52);
      const overtimePay = Math.round((120 / 60) * hourlyRate * 1.5 * 100) / 100;
      const expectedGross = Math.round((6000 - unpaidDeduction + overtimePay) * 100) / 100;
      expect(Number(mainLine.grossPay)).toBeCloseTo(expectedGross, 2);

      // Tax — annualize (grossSalary * 12), apply the REAL US bracket/flat/FICA layers, then de-annualize (/12).
      const annualSalary = expectedGross * 12;
      const fed = progressiveFederalTax(annualSalary);
      const state = annualSalary * 0.05;
      const ss = Math.min(annualSalary, 168_600) * 0.062;
      const medicare = annualSalary * 0.0145;
      const expectedMonthlyTax = Math.round(((fed + state + ss + medicare) / 12) * 100) / 100;
      const expectedNet = Math.round((expectedGross - expectedMonthlyTax) * 100) / 100;
      expect(Number(mainLine.netPay)).toBeCloseTo(expectedNet, 1);
      expect(mainLine.computedVia).toBe('ENGINE');

      // FUTA is EMPLOYER-only — must never reduce the employee's net pay, only appear as employer cost.
      const breakdown = mainLine.componentBreakdown as { key: string; type: string }[];
      expect(breakdown.some((c) => c.key === 'futa' && c.type === 'EMPLOYER_COST')).toBe(true);
      expect(breakdown.some((c) => c.key === 'futa' && c.type === 'EMPLOYEE_STATUTORY')).toBe(false);
      expect(Number(mainLine.employerCost)).toBeGreaterThan(Number(mainLine.grossPay));
    });

    it('a QA-branch run computes zero income tax and a correctly-scoped MONTHLY gratuity accrual (never the cumulative lifetime total)', async () => {
      const createRes = await post('/payroll/runs', tokenAdminA, { branchId: branchQaId, periodYear: 2026, periodMonth: 6 }).expect(201);
      qaRunId = createRes.body.id;
      await post(`/payroll/runs/${qaRunId}/calculate`, tokenAdminA, {}).expect(201);

      const run = await waitFor(async () => {
        const res = await get(`/payroll/runs/${qaRunId}`, tokenAdminA).expect(200);
        return res.body.status === 'CALCULATED' ? res.body : null;
      });
      const line = run.lines.find((l: { employeeId: string }) => l.employeeId === qaEmployeeId);

      // No income tax at all (Qatar's tax.layers: []).
      expect(Number(line.grossPay)).toBeCloseTo(9000, 2);
      expect(Number(line.netPay)).toBeCloseTo(9000, 2); // gratuity is EMPLOYER-only, never reduces net pay.

      const breakdown = line.componentBreakdown as { key: string; type: string; amount: number }[];
      const gratuity = breakdown.find((c) => c.key === 'end_of_service_gratuity');
      expect(gratuity).toBeDefined();
      expect(gratuity!.type).toBe('EMPLOYER_COST');
      // ~3 weeks/year * 300/day monthly-equivalent, divided across ~12 months
      // — a small monthly accrual. THE REGRESSION PROOF: this must be
      // nowhere near the ~18,900 CUMULATIVE 3-years total the tiered
      // formula would return if the engine mistakenly used it directly.
      expect(gratuity!.amount).toBeGreaterThan(50);
      expect(gratuity!.amount).toBeLessThan(2000);

      // Multi-currency rollup: QAR -> the tenant's USD base currency, via the seeded exchange rate, exact Decimal math.
      expect(run.totalGrossBase).not.toBeNull();
      const expectedBase = Math.round(Number(run.totalGross) * 0.2747 * 100) / 100;
      expect(Number(run.totalGrossBase)).toBeCloseTo(expectedBase, 2);
    });
  });

  describe('DELEGATE mode — routes to the adapter, never the engine', () => {
    it('a DELEGATE-mode pack computes via the stub provider, not PayrollEngineService', async () => {
      const createRes = await post('/payroll/runs', tokenAdminA, { branchId: branchDelegateId, periodYear: 2026, periodMonth: 6 }).expect(201);
      delegateRunId = createRes.body.id;
      expect(createRes.body.payrollMode).toBe('DELEGATE');
      await post(`/payroll/runs/${delegateRunId}/calculate`, tokenAdminA, {}).expect(201);

      const run = await waitFor(async () => {
        const res = await get(`/payroll/runs/${delegateRunId}`, tokenAdminA).expect(200);
        const line = res.body.lines?.find((l: { employeeId: string }) => l.employeeId === delegateEmployeeId);
        if (line?.status === 'FAILED') {
          throw new Error(`DEBUG delegate line FAILED: ${line.errorMessage}`);
        }
        return res.body.status === 'CALCULATED' ? res.body : null;
      });
      const line = run.lines.find((l: { employeeId: string }) => l.employeeId === delegateEmployeeId);
      expect(line.computedVia).toBe('DELEGATE');
      expect(Number(line.grossPay)).toBeCloseTo(4000, 2);
      expect(Number(line.netPay)).toBeCloseTo(4000, 2); // the stub does no tax/statutory math at all — that's the whole point of DELEGATE mode.
    });
  });

  describe('idempotency — a re-run never double-processes', () => {
    it('re-triggering calculate on an already-CALCULATED run leaves every line untouched', async () => {
      const before = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
      const beforeComputedAt = before.body.lines.map((l: { computedAt: string }) => l.computedAt).sort();
      const beforeLineCount = before.body.lines.length;

      await post(`/payroll/runs/${usRunId}/calculate`, tokenAdminA, {}).expect(201);
      // Give the (no-op) job a moment to run through.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const after = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
      expect(after.body.lines.length).toBe(beforeLineCount);
      const afterComputedAt = after.body.lines.map((l: { computedAt: string }) => l.computedAt).sort();
      expect(afterComputedAt).toEqual(beforeComputedAt);
      expect(after.body.totalGross).toBe(before.body.totalGross);
    });
  });

  describe('resumability — a partial failure never blocks or reprocesses the rest of the run', () => {
    let resumeRunId: string;

    it('a run with one deliberately-broken employee marks only that line FAILED, and stays out of CALCULATED', async () => {
      const broken = await makeEmployee(tenantAId, branchUsId, { baseSalaryEncrypted: 'not-a-valid-ciphertext', joinDate: new Date('2018-01-01') });
      brokenEmployeeId = broken.id;

      const createRes = await post('/payroll/runs', tokenAdminA, { branchId: branchUsId, periodYear: 2026, periodMonth: 7 }).expect(201);
      resumeRunId = createRes.body.id;
      await post(`/payroll/runs/${resumeRunId}/calculate`, tokenAdminA, {}).expect(201);

      const run = await waitFor(async () => {
        const res = await get(`/payroll/runs/${resumeRunId}`, tokenAdminA).expect(200);
        const failed = res.body.lines.find((l: { employeeId: string; status: string }) => l.employeeId === brokenEmployeeId && l.status === 'FAILED');
        return failed ? res.body : null;
      });

      expect(run.status).not.toBe('CALCULATED'); // not every employee succeeded yet.
      const goodLine = run.lines.find((l: { employeeId: string }) => l.employeeId === usEmployeeId);
      expect(goodLine.status).toBe('COMPUTED');
      const brokenLine = run.lines.find((l: { employeeId: string }) => l.employeeId === brokenEmployeeId);
      expect(brokenLine.errorMessage).toBeTruthy();

      // "Fix" the broken employee, then re-run — only the failed employee should be retried.
      await prisma.employee.update({ where: { id: brokenEmployeeId }, data: { baseSalaryEncrypted: null } });
      await post(`/payroll/runs/${resumeRunId}/calculate`, tokenAdminA, {}).expect(201);

      const resumed = await waitFor(async () => {
        const res = await get(`/payroll/runs/${resumeRunId}`, tokenAdminA).expect(200);
        return res.body.status === 'CALCULATED' ? res.body : null;
      });
      const goodLineAfter = resumed.lines.find((l: { employeeId: string }) => l.employeeId === usEmployeeId);
      const brokenLineAfter = resumed.lines.find((l: { employeeId: string }) => l.employeeId === brokenEmployeeId);
      expect(goodLineAfter.computedAt).toBe(goodLine.computedAt); // never reprocessed.
      expect(brokenLineAfter.status).toBe('COMPUTED');
    });
  });

  describe('run approval flows through the real 0.7 workflow, then finalize/bank-export/payslips', () => {
    it('submits for approval, approves via the generic workflow route, finalizes, exports a bank file, and generates payslips', async () => {
      await post(`/payroll/runs/${usRunId}/submit-for-approval`, tokenAdminA, {}).expect(201);
      const runAfterSubmit = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
      const instanceId = runAfterSubmit.body.workflowInstanceId;
      expect(instanceId).toBeTruthy();

      const instanceDetail = await get(`/workflow/instances/${instanceId}`, tokenAdminA).expect(200);
      const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, tokenAdminA, { actionType: 'APPROVE' }).expect(201);

      const approvedRun = await waitFor(async () => {
        const res = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
        return res.body.status === 'APPROVED' ? res.body : null;
      });
      expect(approvedRun.status).toBe('APPROVED');

      await post(`/payroll/runs/${usRunId}/finalize`, tokenAdminA, {}).expect(201);
      const finalizedRun = await get(`/payroll/runs/${usRunId}`, tokenAdminA).expect(200);
      expect(finalizedRun.body.status).toBe('FINALIZED');

      const bankExportRes = await download('post', `/payroll/runs/${usRunId}/bank-export`, tokenAdminA).expect(201);
      const csv = (bankExportRes.body as Buffer).toString('utf8');
      expect(csv).toContain('employee_code');
      expect(csv).toContain('First Test Bank');

      // Self-service payslip download.
      const selfToken = jwt.sign({ sub: usEmployeeUserId, tenantId: tenantAId });
      const payslipRes = await download('get', `/payroll/runs/${usRunId}/payslips/${usEmployeeId}`, selfToken).expect(200);
      expect(payslipRes.headers['content-type']).toContain('application/pdf');
      expect((payslipRes.body as Buffer).subarray(0, 4).toString('utf8')).toBe('%PDF');

      // A QA-branch payslip, in Arabic, generated from a SEPARATE, already-CALCULATED run (proves locale-correctness independent of the US flow above).
      const qaSelfToken = jwt.sign({ sub: qaEmployeeUserId, tenantId: tenantAId });
      const qaPayslipRes = await download('get', `/payroll/runs/${qaRunId}/payslips/${qaEmployeeId}`, qaSelfToken).expect(200);
      expect((qaPayslipRes.body as Buffer).subarray(0, 4).toString('utf8')).toBe('%PDF');

      // Someone else's payslip is forbidden without payslip.view.
      await get(`/payroll/runs/${usRunId}/payslips/${usEmployeeId}`, qaSelfToken).expect(403);
    });
  });

  describe('field-level permissions — salary.view gates amounts, not existence', () => {
    it('a caller with payroll.run but no salary.view sees the run without any amount fields', async () => {
      const res = await get(`/payroll/runs/${usRunId}`, tokenHrNoSalaryViewA).expect(200);
      expect('totalGross' in res.body).toBe(false);
      expect('totalNet' in res.body).toBe(false);
      expect(res.body.lines.every((l: object) => !('grossPay' in l) && !('netPay' in l))).toBe(true);
      // Non-financial fields remain visible.
      expect(res.body.status).toBeDefined();
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot read tenant A's payroll run by id", async () => {
      await get(`/payroll/runs/${usRunId}`, tokenAdminB, TENANT_B_SLUG).expect(404);
    });
  });
});

/** Mirrors the US reference pack's federal bracket table exactly — used only to compute the TEST's expected value, never imported into src. */
function progressiveFederalTax(annualSalary: number): number {
  const brackets: [number | null, number][] = [
    [11_600, 0.1],
    [47_150, 0.12],
    [100_525, 0.22],
    [191_950, 0.24],
    [null, 0.32],
  ];
  let tax = 0;
  let previousUpTo = 0;
  for (const [upTo, rate] of brackets) {
    const bound = upTo ?? Infinity;
    const band = Math.max(0, Math.min(annualSalary, bound) - previousUpTo);
    tax += band * rate;
    previousUpTo = bound;
    if (annualSalary <= bound) break;
  }
  return tax;
}
