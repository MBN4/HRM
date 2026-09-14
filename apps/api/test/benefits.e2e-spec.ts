/**
 * Proves the Benefits Administration module (step 3.5.2) end to end over
 * real HTTP — see docs/conventions/benefits.md. THE BOUNDARY: benefits
 * never compute pay — a plan enrollment and a country-pack statutory
 * scheme both only ever produce PAYROLL INPUTS, merged onto a real
 * `PayrollRun` by `PayrollRunProcessor`'s additive `mergeBenefitContributions`
 * step, the payroll ENGINE itself completely untouched (proven the same
 * way operations-modules.md proves the expense-reimbursement hand-off).
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
import { BENEFIT_ENROLLMENT_ENTITY_TYPE } from '../src/benefits/benefits.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'benefits-test-tenant-a';
const TENANT_B_SLUG = 'benefits-test-tenant-b';
const PK_COUNTRY_CODE = 'PK';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

// Pakistan is now a REAL, seeded reference pack (step 3.5.4 — see
// docs/conventions/pakistan-pack.md) — `seedCountryPacks()` below seeds it
// exactly like US/QA, replacing the ad-hoc pack this suite used to create
// directly (3.5.2). No local PK_PACK_CONFIG needed anymore; `branchPkId`
// below just points at the real seeded `PK` country code.

const ZERO_TAX_COUNTRY_CODE = 'ZB';

// A clean, zero-tax/zero-statutory pack — deliberately isolates the
// plan-CONFIGURATION proofs (FIXED_AMOUNT/PERCENTAGE_OF_BASE/FORMULA/
// tiered) from tax/statutory noise, the same "test-specific fixture,
// never touching seed-country-packs.ts" precedent as `PK_PACK_CONFIG`
// above and payroll.e2e-spec.ts's own DELEGATE-mode pack.
const ZERO_TAX_PACK_CONFIG: CountryPackConfig = {
  locale: { currencyCode: 'USD', currencySymbol: '$', numberFormat: 'en-US', dateFormat: 'MM/DD/YYYY', defaultLanguage: 'en', rtl: false, firstDayOfWeek: 'SUNDAY' },
  workingTime: { standardWeeklyHours: 40, weekendDays: ['SATURDAY', 'SUNDAY'], overtimeRules: { multiplier: 1.5 } },
  leaveDefaults: { annualDays: 0, sickDays: 0, maternityDays: 0, paternityDays: 0 },
  publicHolidays: {},
  tax: { layers: [] },
  statutory: { components: [] },
  requiredEmployeeFields: [],
  payslipTemplate: { language: 'en', lineItems: [{ key: 'gross', label: 'Gross' }, { key: 'net', label: 'Net' }] },
  payrollMode: 'CALCULATE',
  hostingRegionHint: 'us-east-1',
};

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  // PK is now a real, permanent seeded reference pack (like US/QA) — never
  // deleted here, only the test-specific ZERO_TAX pack is cleaned up.
  await prisma.countryPack.deleteMany({ where: { countryCode: ZERO_TAX_COUNTRY_CODE } });
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

describe('benefits administration (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchZeroTaxId: string;
  let branchQaId: string;
  let branchPkId: string;

  let tokenAdminA: string;
  let tokenAdminB: string;
  let tokenEmployeeA: string;
  let tokenManageNoSalaryViewA: string;

  let employeeUserId: string;

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  async function makeEmployeeWithSalary(branchId: string, baseSalary: number, salaryCurrency: string, userId?: string) {
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId,
        employeeCode: `BEN-${Math.random().toString(36).slice(2, 8)}`,
        firstName: 'Test',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
        userId,
      },
    });
    await request(app.getHttpServer())
      .patch(`/employees/${employee.id}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary, salaryCurrency } })
      .expect(200);
    return employee;
  }

  async function runPayroll(branchId: string, periodYear: number, periodMonth: number) {
    const createRes = await post('/payroll/runs', tokenAdminA, { branchId, periodYear, periodMonth }).expect(201);
    const runId = createRes.body.id;
    await post(`/payroll/runs/${runId}/calculate`, tokenAdminA, {}).expect(201);
    await waitFor(async () => {
      const row = await prisma.payrollRun.findUnique({ where: { id: runId } });
      return row && row.status === 'CALCULATED' ? row : null;
    });
    return runId;
  }

  async function lineFor(runId: string, employeeId: string) {
    return prisma.payrollRunLine.findFirstOrThrow({ where: { payrollRunId: runId, employeeId } });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma); // seeds the REAL US/QA/PK reference packs
    await prisma.countryPack.create({ data: { countryCode: ZERO_TAX_COUNTRY_CODE, version: 1, isActive: true, config: ZERO_TAX_PACK_CONFIG } });

    for (const [base, rate] of [
      ['QAR', '0.2747'],
      ['PKR', '0.0036'],
    ] as const) {
      await prisma.exchangeRate.upsert({
        where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency: base, quoteCurrency: 'USD', asOfDate: new Date('2026-01-01') } },
        update: { rate },
        create: { baseCurrency: base, quoteCurrency: 'USD', rate, asOfDate: new Date('2026-01-01') },
      });
    }

    const tenantA = await prisma.tenant.create({
      data: { name: 'Benefits Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1', baseCurrencyCode: 'USD' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Benefits Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    for (const tenantId of [tenantAId, tenantBId]) {
      await prisma.tenantFeatureFlagOverride.create({ data: { tenantId, flagKey: 'multi_country_payroll', enabled: true } });
    }

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    branchZeroTaxId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Benefits A Zero-Tax Branch', countryCode: ZERO_TAX_COUNTRY_CODE, timezone: 'America/New_York' } })).id;
    branchQaId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Benefits A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;
    branchPkId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Benefits A Karachi Office', countryCode: PK_COUNTRY_CODE, timezone: 'Asia/Karachi' } })).id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    // A "manages benefits but cannot see salary" role — mirrors payroll.e2e-spec.ts's own `PAYROLL_NO_SALARY_VIEW` fixture role exactly, for the SAME field-omission proof isolated from TENANT_ADMIN's other permissions.
    const manageNoSalaryRole = await prisma.role.create({ data: { tenantId: tenantAId, name: 'BENEFITS_MANAGE_NO_SALARY_VIEW', isSystem: false } });
    const benefitsManagePermission = await prisma.permission.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenantAId, key: 'benefits.manage' } } });
    const benefitsReadPermission = await prisma.permission.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenantAId, key: 'benefits.read' } } });
    await prisma.rolePermission.createMany({
      data: [
        { tenantId: tenantAId, roleId: manageNoSalaryRole.id, permissionId: benefitsManagePermission.id },
        { tenantId: tenantAId, roleId: manageNoSalaryRole.id, permissionId: benefitsReadPermission.id },
      ],
    });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@benefits-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@benefits-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
    const manageNoSalaryUser = await makeUserWithRole(tenantAId, manageNoSalaryRole.id, 'manage-no-salary@benefits-a.test');
    tokenManageNoSalaryViewA = jwt.sign({ sub: manageNoSalaryUser.id, tenantId: tenantAId });

    const employeeUser = await makeUserWithRole(tenantAId, employeeRoleA.id, 'employee@benefits-a.test');
    employeeUserId = employeeUser.id;
    tokenEmployeeA = jwt.sign({ sub: employeeUser.id, tenantId: tenantAId });

    const templateApproval = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Benefit Enrollment Approval', entityType: BENEFIT_ENROLLMENT_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: templateApproval.id, name: 'Admin approval', order: 1, approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    // Also needed so the cross-cutting payroll runs this suite creates can be approved/finalized if ever exercised — mirrors payroll.e2e-spec.ts's own fixture template.
    const templatePayroll = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: 'Payroll Run Approval', entityType: PAYROLL_RUN_ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: templatePayroll.id, name: 'Admin approval', order: 1, approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN } },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('plan configuration — FIXED_AMOUNT / PERCENTAGE_OF_BASE / FORMULA / tiered, correct Decimal payroll inputs', () => {
    let empFixedId: string;
    let empPercentageId: string;
    let empFormulaId: string;
    let empTierSoloId: string;
    let empTierFamilyId: string;
    let dependentId: string;

    let fixedPlanId: string;
    let percentagePlanId: string;
    let formulaPlanId: string;
    let tieredPlanId: string;
    let soloTierId: string;
    let familyTierId: string;

    let runId: string;

    it('an admin defines a FIXED_AMOUNT, a PERCENTAGE_OF_BASE, a FORMULA, and a tiered plan', async () => {
      const fixedRes = await post('/benefits/plans', tokenAdminA, {
        code: 'commuter_allowance',
        name: 'Commuter Allowance',
        benefitType: 'ALLOWANCE',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 60,
        employeeSharePercent: 0.25,
        employerSharePercent: 0.75,
      }).expect(201);
      fixedPlanId = fixedRes.body.id;

      const percentageRes = await post('/benefits/plans', tokenAdminA, {
        code: 'health_insurance_pct',
        name: 'Health Insurance (% of gross)',
        benefitType: 'HEALTH_INSURANCE',
        currencyCode: 'USD',
        costBasis: 'PERCENTAGE_OF_BASE',
        percentageOfBase: 'grossSalary',
        percentageRate: 0.02,
        employeeSharePercent: 0.5,
        employerSharePercent: 0.5,
      }).expect(201);
      percentagePlanId = percentageRes.body.id;

      const formulaRes = await post('/benefits/plans', tokenAdminA, {
        code: 'wellness_stipend',
        name: 'Wellness Stipend',
        benefitType: 'OTHER',
        currencyCode: 'USD',
        costBasis: 'FORMULA',
        formula: {
          type: 'clamp',
          value: { type: 'binary', op: '*', left: { type: 'var', name: 'basicSalary' }, right: { type: 'const', value: 0.01 } },
          max: { type: 'const', value: 40 },
        },
        employeeSharePercent: 0.5,
        employerSharePercent: 0.5,
      }).expect(201);
      formulaPlanId = formulaRes.body.id;

      const tieredRes = await post('/benefits/plans', tokenAdminA, {
        code: 'family_medical',
        name: 'Family Medical Plan',
        benefitType: 'HEALTH_INSURANCE',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 0,
        employeeSharePercent: 0,
        employerSharePercent: 1,
        hasTiers: true,
        tiers: [
          { key: 'SOLO', label: 'Employee only', employeeAmount: 20, employerAmount: 80, order: 0 },
          { key: 'FAMILY', label: 'Employee + family', employeeAmount: 60, employerAmount: 140, order: 1 },
        ],
      }).expect(201);
      tieredPlanId = tieredRes.body.id;
      soloTierId = tieredRes.body.tiers.find((t: { key: string }) => t.key === 'SOLO').id;
      familyTierId = tieredRes.body.tiers.find((t: { key: string }) => t.key === 'FAMILY').id;

      expect((await get('/benefits/plans', tokenEmployeeA)).status).toBe(200);
    });

    it('rejects a plan whose employee/employer share does not sum to 1.0', async () => {
      await post('/benefits/plans', tokenAdminA, {
        code: 'broken_shares',
        name: 'Broken',
        benefitType: 'OTHER',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 10,
        employeeSharePercent: 0.5,
        employerSharePercent: 0.6,
      }).expect(400);
    });

    it('a non-admin cannot define a plan (deny-by-default RBAC)', async () => {
      await post('/benefits/plans', tokenEmployeeA, {
        code: 'blocked',
        name: 'Blocked',
        benefitType: 'OTHER',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 1,
        employeeSharePercent: 1,
        employerSharePercent: 0,
      }).expect(403);
    });

    it('enrolls employees (admin-assigned) in each plan, including a dependent on the FAMILY tier', async () => {
      empFixedId = (await makeEmployeeWithSalary(branchZeroTaxId, 5000, 'USD')).id;
      empPercentageId = (await makeEmployeeWithSalary(branchZeroTaxId, 5000, 'USD')).id;
      empFormulaId = (await makeEmployeeWithSalary(branchZeroTaxId, 5000, 'USD')).id;
      empTierSoloId = (await makeEmployeeWithSalary(branchZeroTaxId, 5000, 'USD')).id;
      empTierFamilyId = (await makeEmployeeWithSalary(branchZeroTaxId, 5000, 'USD')).id;

      const dependentRes = await request(app.getHttpServer())
        .patch(`/employees/${empTierFamilyId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ dependents: [{ name: 'Child One', relationship: 'CHILD' }] })
        .expect(200);
      dependentId = dependentRes.body.dependents[0].id;

      await post('/benefits/enrollments', tokenAdminA, { employeeId: empFixedId, planId: fixedPlanId, effectiveFrom: '2026-06-01' }).expect(201);
      await post('/benefits/enrollments', tokenAdminA, { employeeId: empPercentageId, planId: percentagePlanId, effectiveFrom: '2026-06-01' }).expect(201);
      await post('/benefits/enrollments', tokenAdminA, { employeeId: empFormulaId, planId: formulaPlanId, effectiveFrom: '2026-06-01' }).expect(201);
      await post('/benefits/enrollments', tokenAdminA, { employeeId: empTierSoloId, planId: tieredPlanId, coverageTierId: soloTierId, effectiveFrom: '2026-06-01' }).expect(201);
      await post('/benefits/enrollments', tokenAdminA, {
        employeeId: empTierFamilyId,
        planId: tieredPlanId,
        coverageTierId: familyTierId,
        effectiveFrom: '2026-06-01',
        dependentIds: [dependentId],
      }).expect(201);
    });

    it('a real Payroll run merges every ACTIVE enrollment into the correct employee deduction + employer contribution, WITHOUT modifying the engine', async () => {
      runId = await runPayroll(branchZeroTaxId, 2026, 6);

      const fixedLine = await lineFor(runId, empFixedId);
      expect(Number(fixedLine.netPay)).toBeCloseTo(5000 - 15, 2); // 60 * 0.25 employee share
      expect(Number(fixedLine.employerCost)).toBeCloseTo(5000 + 45, 2); // 60 * 0.75 employer share

      const percentageLine = await lineFor(runId, empPercentageId);
      expect(Number(percentageLine.netPay)).toBeCloseTo(5000 - 50, 2); // 2% of 5000 = 100, 50/50 split
      expect(Number(percentageLine.employerCost)).toBeCloseTo(5000 + 50, 2);

      const formulaLine = await lineFor(runId, empFormulaId);
      expect(Number(formulaLine.netPay)).toBeCloseTo(5000 - 20, 2); // clamp(5000*0.01, 40) = 40, 50/50 split
      expect(Number(formulaLine.employerCost)).toBeCloseTo(5000 + 20, 2);

      // The tiered plan proves coverage tier ALONE changes the resulting
      // cost — same plan, different tier, different Decimal amount.
      const soloLine = await lineFor(runId, empTierSoloId);
      expect(Number(soloLine.netPay)).toBeCloseTo(5000 - 20, 2);
      expect(Number(soloLine.employerCost)).toBeCloseTo(5000 + 80, 2);

      const familyLine = await lineFor(runId, empTierFamilyId);
      expect(Number(familyLine.netPay)).toBeCloseTo(5000 - 60, 2);
      expect(Number(familyLine.employerCost)).toBeCloseTo(5000 + 140, 2);

      const breakdown = familyLine.componentBreakdown as { key: string; type: string; amount: number }[];
      expect(breakdown.some((c) => c.key === `benefit_${tieredPlanId}_employee` && c.type === 'DEDUCTION' && c.amount === 60)).toBe(true);
      expect(breakdown.some((c) => c.key === `benefit_${tieredPlanId}_employer` && c.type === 'EMPLOYER_COST' && c.amount === 140)).toBe(true);

      // A real, persisted proof row — no float, Decimal all the way through.
      const record = await prisma.benefitContributionRecord.findFirstOrThrow({ where: { tenantId: tenantAId, employeeId: empTierFamilyId, periodYear: 2026, periodMonth: 6 } });
      expect(record.employeeAmount.toString()).toBe('60');
      expect(record.employerAmount.toString()).toBe('140');
      expect(record.payrollRunLineId).toBe(familyLine.id);
    });

    it("an employee sees their own enrollment via GET /benefits/my-benefits without needing benefits.manage", async () => {
      // Link the fixed-plan employee's own user for a genuine self-service read.
      const linked = await prisma.employee.update({ where: { id: empFixedId }, data: { userId: employeeUserId } });
      expect(linked.userId).toBe(employeeUserId);
      const res = await get('/benefits/my-benefits', tokenEmployeeA).expect(200);
      expect(res.body.some((e: { planId: string }) => e.planId === fixedPlanId)).toBe(true);
    });

    it('a plan with allowSelfElection=false rejects a self-election attempt but allows admin assignment', async () => {
      const restrictedRes = await post('/benefits/plans', tokenAdminA, {
        code: 'exec_perk',
        name: 'Executive Perk',
        benefitType: 'OTHER',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 10,
        employeeSharePercent: 0,
        employerSharePercent: 1,
        allowSelfElection: false,
      }).expect(201);

      await post('/benefits/enrollments', tokenEmployeeA, { planId: restrictedRes.body.id, effectiveFrom: '2026-06-01' }).expect(403);
      await post('/benefits/enrollments', tokenAdminA, { employeeId: empFixedId, planId: restrictedRes.body.id, effectiveFrom: '2026-06-01' }).expect(201);
    });

    it('an employee cannot enroll another employee (deny-by-default RBAC)', async () => {
      await post('/benefits/enrollments', tokenEmployeeA, { employeeId: empPercentageId, planId: fixedPlanId, effectiveFrom: '2026-06-01' }).expect(403);
    });
  });

  describe('statutory schemes differ by country from the SAME rules engine', () => {
    it('QA and PK branches resolve DIFFERENT statutory schemes through the identical GET /benefits/statutory endpoint', async () => {
      const qaRes = await get(`/benefits/statutory?branchId=${branchQaId}`, tokenAdminA).expect(200);
      expect(qaRes.body.countryCode).toBe('QA');
      expect(qaRes.body.components.map((c: { name: string }) => c.name)).toEqual(['end_of_service_gratuity', 'grsia_pension_employee', 'grsia_pension_employer']);

      const pkRes = await get(`/benefits/statutory?branchId=${branchPkId}`, tokenAdminA).expect(200);
      expect(pkRes.body.countryCode).toBe('PK');
      expect(pkRes.body.components.map((c: { name: string }) => c.name)).toEqual([
        'eobi_employee',
        'eobi_employer',
        'provident_fund_employee',
        'provident_fund_employer',
      ]);
    });

    it('a real PK payroll run computes income tax + EOBI + Provident Fund correctly — same engine, third country, zero code change', async () => {
      // Proves the WIRING (the same unmodified rules engine correctly
      // applies the real Pakistan pack's income tax bracket + two
      // wage-ceiling-based/percentage statutory components to a real
      // payroll run) — NOT that these figures are legally correct amounts.
      // Every rate/threshold/cap below is copied directly from the pack's
      // own documented VERIFY-placeholder figures (see
      // seed-country-packs.ts's PAKISTAN_PACK) — this test would need to
      // change the moment those placeholders are replaced with real,
      // verified law, which is exactly the point: the pack is the single
      // source of truth, this test just proves the engine reads it correctly.
      const basicSalary = 150_000;
      const empPk = await makeEmployeeWithSalary(branchPkId, basicSalary, 'PKR');
      const runId = await runPayroll(branchPkId, 2026, 6);
      const line = await lineFor(runId, empPk.id);

      // income_tax: PROGRESSIVE_BRACKETS on annualSalary (150,000 * 12 =
      // 1,800,000), de-annualized by /12 back to a monthly figure (the
      // existing, unmodified "annualize -> compute -> de-annualize"
      // engine behavior — see docs/conventions/payroll.md):
      //   0-600,000 @ 0%      = 0
      //   600,000-1,200,000 @ 5%  = 30,000
      //   1,200,000-1,800,000 @ 15% = 90,000
      //   annual total = 120,000 -> monthly = 10,000
      const expectedIncomeTax = 10_000;
      // eobi_*: PERCENTAGE of basicSalary capped at the pack's 29,000 wage ceiling.
      const eobiBase = Math.min(basicSalary, 29_000);
      const expectedEobiEmployee = Math.round(eobiBase * 0.01 * 100) / 100;
      const expectedEobiEmployer = Math.round(eobiBase * 0.05 * 100) / 100;
      // provident_fund_*: PERCENTAGE of basicSalary, no cap.
      const expectedPfEmployee = Math.round(basicSalary * 0.0833 * 100) / 100;
      const expectedPfEmployer = Math.round(basicSalary * 0.0833 * 100) / 100;

      const expectedNet = basicSalary - expectedIncomeTax - expectedEobiEmployee - expectedPfEmployee;
      const expectedEmployerCost = basicSalary + expectedEobiEmployer + expectedPfEmployer;
      expect(Number(line.netPay)).toBeCloseTo(expectedNet, 2);
      expect(Number(line.employerCost)).toBeCloseTo(expectedEmployerCost, 2);

      const breakdown = line.componentBreakdown as { key: string; type: string; amount: number }[];
      expect(breakdown.find((c) => c.key === 'income_tax')).toMatchObject({ type: 'TAX', amount: expectedIncomeTax });
      expect(breakdown.find((c) => c.key === 'eobi_employee')).toMatchObject({ type: 'EMPLOYEE_STATUTORY', amount: expectedEobiEmployee });
      expect(breakdown.find((c) => c.key === 'eobi_employer')).toMatchObject({ type: 'EMPLOYER_COST', amount: expectedEobiEmployer });
      expect(breakdown.find((c) => c.key === 'provident_fund_employee')).toMatchObject({ type: 'EMPLOYEE_STATUTORY', amount: expectedPfEmployee });
      expect(breakdown.find((c) => c.key === 'provident_fund_employer')).toMatchObject({ type: 'EMPLOYER_COST', amount: expectedPfEmployer });
    });
  });

  describe('enrollment approval via the real 0.7 workflow', () => {
    let approvalPlanId: string;
    let approvalEmployeeId: string;
    let enrollmentId: string;

    it('a requiresApproval plan starts PENDING_APPROVAL and is NOT applied to payroll until approved', async () => {
      const planRes = await post('/benefits/plans', tokenAdminA, {
        code: 'supplemental_life',
        name: 'Supplemental Life Insurance',
        benefitType: 'LIFE_INSURANCE',
        currencyCode: 'USD',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 30,
        employeeSharePercent: 1,
        employerSharePercent: 0,
        requiresApproval: true,
        allowSelfElection: true,
      }).expect(201);
      approvalPlanId = planRes.body.id;

      const empUser = await makeUserWithRole(tenantAId, (await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } })).id, 'approval-emp@benefits-a.test');
      const employee = await makeEmployeeWithSalary(branchZeroTaxId, 4000, 'USD', empUser.id);
      approvalEmployeeId = employee.id;

      const enrollRes = await post('/benefits/enrollments', jwt.sign({ sub: empUser.id, tenantId: tenantAId }), { planId: approvalPlanId, effectiveFrom: '2026-07-01' }).expect(201);
      enrollmentId = enrollRes.body.id;
      expect(enrollRes.body.status).toBe('PENDING_APPROVAL');
      expect(enrollRes.body.workflowInstanceId).toBeTruthy();

      // Runs July's payroll BEFORE approval — the pending enrollment must contribute nothing.
      const runId = await runPayroll(branchZeroTaxId, 2026, 7);
      const line = await lineFor(runId, approvalEmployeeId);
      expect(Number(line.netPay)).toBeCloseTo(4000, 2);
      const count = await prisma.benefitContributionRecord.count({ where: { tenantId: tenantAId, enrollmentId } });
      expect(count).toBe(0);
    });

    it('approving via the generic workflow route flips the enrollment ACTIVE, then a later run applies it', async () => {
      const detail = await get(`/workflow/instances/${(await prisma.benefitEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } })).workflowInstanceId}`, tokenAdminA).expect(200);
      const step = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      await post(`/workflow/instances/${detail.body.instance.id}/steps/${step.id}/actions`, tokenAdminA, { actionType: 'APPROVE' }).expect(201);

      const enrollment = await waitFor(async () => {
        const row = await prisma.benefitEnrollment.findUnique({ where: { id: enrollmentId } });
        return row && row.status === 'ACTIVE' ? row : null;
      });
      expect(enrollment.status).toBe('ACTIVE');

      const runId = await runPayroll(branchZeroTaxId, 2026, 8);
      const line = await lineFor(runId, approvalEmployeeId);
      expect(Number(line.netPay)).toBeCloseTo(4000 - 30, 2);
    });
  });

  describe('cost reporting — employee vs employer share, branch-scoped, field-level gated', () => {
    it('combines plan-based and statutory totals for a branch/period, and gates amounts behind salary.view', async () => {
      const empQa = await makeEmployeeWithSalary(branchQaId, 8000, 'QAR');
      const planRes = await post('/benefits/plans', tokenAdminA, {
        code: 'health_insurance_qa',
        name: 'Health Insurance QA',
        benefitType: 'HEALTH_INSURANCE',
        currencyCode: 'QAR',
        costBasis: 'FIXED_AMOUNT',
        fixedAmount: 40,
        employeeSharePercent: 0.6,
        employerSharePercent: 0.4,
      }).expect(201);
      await post('/benefits/enrollments', tokenAdminA, { employeeId: empQa.id, planId: planRes.body.id, effectiveFrom: '2026-06-01' }).expect(201);
      await runPayroll(branchQaId, 2026, 6);

      const reportAdmin = await get(`/benefits/cost-report?periodYear=2026&periodMonth=6&branchId=${branchQaId}`, tokenAdminA).expect(200);
      const planLine = reportAdmin.body.plans.find((p: { planId: string }) => p.planId === planRes.body.id);
      expect(planLine.employeeTotal).toBe('24'); // 40 * 0.6
      expect(planLine.employerTotal).toBe('16'); // 40 * 0.4

      const grsiaEmployee = reportAdmin.body.statutory.find((s: { name: string }) => s.name === 'grsia_pension_employee');
      const grsiaEmployer = reportAdmin.body.statutory.find((s: { name: string }) => s.name === 'grsia_pension_employer');
      expect(Number(grsiaEmployee.employeeTotal)).toBeCloseTo(8000 * 0.05, 2);
      expect(Number(grsiaEmployer.employerTotal)).toBeCloseTo(8000 * 0.1, 2);
      // The statutory extraction must never double-count this module's own
      // benefit_*-keyed breakdown lines (also tagged EMPLOYER_COST).
      expect(reportAdmin.body.statutory.some((s: { name: string }) => s.name.startsWith('benefit_'))).toBe(false);

      const reportNoSalaryView = await get(`/benefits/cost-report?periodYear=2026&periodMonth=6&branchId=${branchQaId}`, tokenManageNoSalaryViewA).expect(200);
      expect(reportNoSalaryView.body.plans.every((p: object) => !('employeeTotal' in p) && !('employerTotal' in p))).toBe(true);
      expect(reportNoSalaryView.body.statutory.every((s: object) => !('employeeTotal' in s) && !('employerTotal' in s))).toBe(true);

      await get(`/benefits/cost-report?periodYear=2026&periodMonth=6&branchId=${branchQaId}`, tokenEmployeeA).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot read tenant A's benefit plans or enrollments", async () => {
      const plan = await prisma.benefitPlan.findFirst({ where: { tenantId: tenantAId } });
      await get(`/benefits/plans/${plan!.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);

      const listRes = await get('/benefits/plans', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listRes.body.length).toBe(0);
    });
  });
});
