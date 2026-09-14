/**
 * Proves the Statutory / Government Reporting module (step 3.5.4) end to
 * end over real HTTP — see docs/conventions/statutory-reporting.md. THE
 * BOUNDARY: this module GENERATES filing forms/exports FROM already-
 * FINALIZED `PayrollRun` data (2.1) — it never recomputes a figure. Pakistan
 * is the first concrete country; the "country-extensibility" proof is that
 * the report CATALOG (`StatutoryReportDefinition`) is resolved generically
 * from a branch's own country code, with zero branching on country code
 * anywhere in `apps/api/src/statutory-reporting`.
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
import { appPrisma, prisma, seedCountryPacks, seedStatutoryReportDefinitions, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { PAYROLL_RUN_ENTITY_TYPE } from '../src/payroll/payroll.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'statutory-reporting-test-tenant-a';
const TENANT_B_SLUG = 'statutory-reporting-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
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

describe('statutory reporting (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchPkId: string;
  let branchPkDraftId: string;
  let branchQaId: string;

  let tokenAdminA: string;
  let tokenAdminB: string;
  let tokenEmployeeA: string;

  let empPkId: string;

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }
  /** Reliably buffers a binary/text response (PDF, CSV) as a real `Buffer` — the SAME `.buffer(true).parse(...)` pattern `payroll.e2e-spec.ts`'s own `download` helper establishes. */
  function download(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      .get(path)
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

  async function makeEmployeeWithSalaryAndStatutoryFields(branchId: string, baseSalary: number, salaryCurrency: string, statutoryFields: Record<string, string>) {
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId,
        employeeCode: `SR-${Math.random().toString(36).slice(2, 8)}`,
        firstName: 'Test',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });
    await request(app.getHttpServer())
      .patch(`/employees/${employee.id}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ compensation: { baseSalary, salaryCurrency }, statutoryFields })
      .expect(200);
    return employee;
  }

  /** Runs a period's payroll all the way to FINALIZED — calculate, submit for approval, approve via the generic workflow route, finalize. Mirrors payroll.e2e-spec.ts's own approval-flow test exactly. */
  async function runAndFinalizePayroll(branchId: string, periodYear: number, periodMonth: number): Promise<string> {
    const createRes = await post('/payroll/runs', tokenAdminA, { branchId, periodYear, periodMonth }).expect(201);
    const runId = createRes.body.id;
    await post(`/payroll/runs/${runId}/calculate`, tokenAdminA, {}).expect(201);
    await waitFor(async () => {
      const row = await prisma.payrollRun.findUnique({ where: { id: runId } });
      return row && row.status === 'CALCULATED' ? row : null;
    });

    await post(`/payroll/runs/${runId}/submit-for-approval`, tokenAdminA, {}).expect(201);
    const runAfterSubmit = await get(`/payroll/runs/${runId}`, tokenAdminA).expect(200);
    const instanceId = runAfterSubmit.body.workflowInstanceId;
    const instanceDetail = await get(`/workflow/instances/${instanceId}`, tokenAdminA).expect(200);
    const activeStep = instanceDetail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
    await post(`/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`, tokenAdminA, { actionType: 'APPROVE' }).expect(201);
    await waitFor(async () => {
      const row = await prisma.payrollRun.findUnique({ where: { id: runId } });
      return row && row.status === 'APPROVED' ? row : null;
    });

    await post(`/payroll/runs/${runId}/finalize`, tokenAdminA, {}).expect(201);
    return runId;
  }

  /** Generates a report and waits for it to leave PENDING/GENERATING — returns the final row (COMPLETED or FAILED). */
  async function generateAndWait(branchId: string, reportCode: string, periodYear: number, periodMonth?: number) {
    const res = await post('/statutory-reports/generate', tokenAdminA, { branchId, reportCode, periodYear, periodMonth }).expect(201);
    const reportId = res.body.id;
    const final = await waitFor(async () => {
      const row = await prisma.generatedReport.findUnique({ where: { id: reportId } });
      return row && (row.status === 'COMPLETED' || row.status === 'FAILED') ? row : null;
    });
    return { reportId, final };
  }

  function parseCsvRow(csv: string, employeeCode: string): string[] {
    const line = csv.split('\n').find((l) => l.includes(employeeCode));
    if (!line) {
      throw new Error(`No CSV row found for employee code "${employeeCode}" in:\n${csv}`);
    }
    // A simple splitter is fine here — none of this suite's own test data contains a comma inside a quoted field.
    return line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);
    await seedStatutoryReportDefinitions(prisma);

    for (const [base, rate] of [['PKR', '0.0036']] as const) {
      await prisma.exchangeRate.upsert({
        where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency: base, quoteCurrency: 'USD', asOfDate: new Date('2026-01-01') } },
        update: { rate },
        create: { baseCurrency: base, quoteCurrency: 'USD', rate, asOfDate: new Date('2026-01-01') },
      });
    }

    const tenantA = await prisma.tenant.create({
      data: { name: 'Statutory Reporting Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'PK', hostingRegion: 'us-east-1', baseCurrencyCode: 'USD' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Statutory Reporting Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'PK', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    for (const tenantId of [tenantAId, tenantBId]) {
      await prisma.tenantFeatureFlagOverride.create({ data: { tenantId, flagKey: 'multi_country_payroll', enabled: true } });
    }

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    branchPkId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'SR A Karachi Office', countryCode: 'PK', timezone: 'Asia/Karachi' } })).id;
    // A SEPARATE branch for the "draft run isn't reported" test below — a
    // REGULAR payroll run pulls in EVERY ACTIVE employee on its branch
    // (PayrollRunProcessor.process), so that test's own fixture employee
    // must not land on the SAME branch the main employeeCount/totals
    // assertions below depend on staying at exactly one employee.
    branchPkDraftId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'SR A Lahore Office', countryCode: 'PK', timezone: 'Asia/Karachi' } })).id;
    branchQaId = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'SR A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@statutory-reporting-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@statutory-reporting-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
    const employeeA = await makeUserWithRole(tenantAId, employeeRoleA.id, 'employee@statutory-reporting-a.test');
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

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

  describe('the report catalog resolves generically from a branch\'s own country (country-extensibility proof)', () => {
    it('a PK branch resolves all four seeded PK report definitions through the same endpoint a future country would use', async () => {
      const res = await get(`/statutory-reports/definitions?branchId=${branchPkId}`, tokenAdminA).expect(200);
      expect(res.body.map((d: { reportCode: string }) => d.reportCode).sort()).toEqual([
        'PK_ANNUAL_SALARY_TAX_STATEMENT',
        'PK_EOBI_CONTRIBUTION',
        'PK_INCOME_TAX_WITHHOLDING',
        'PK_PROVIDENT_FUND_CONTRIBUTION',
      ]);
      expect(res.body.every((d: { complianceNote: string }) => d.complianceNote.startsWith('VERIFY:'))).toBe(true);
    });

    it('a QA branch — a country with no seeded report definitions — resolves an EMPTY catalog, not an error: adding a country is purely additive data', async () => {
      const res = await get(`/statutory-reports/definitions?branchId=${branchQaId}`, tokenAdminA).expect(200);
      expect(res.body).toEqual([]);
    });

    it('a non-admin cannot read the catalog (deny-by-default RBAC)', async () => {
      await get(`/statutory-reports/definitions?branchId=${branchPkId}`, tokenEmployeeA).expect(403);
    });
  });

  describe('reports pull ONLY finalized payroll-run data', () => {
    it('a draft/calculated (not finalized) run is NOT reported — generation fails loudly rather than silently reporting zero', async () => {
      await makeEmployeeWithSalaryAndStatutoryFields(branchPkDraftId, 100_000, 'PKR', { CNIC: '11111-1111111-1', NTN: '1111111-1' });
      const createRes = await post('/payroll/runs', tokenAdminA, { branchId: branchPkDraftId, periodYear: 2026, periodMonth: 9 }).expect(201);
      const runId = createRes.body.id;
      await post(`/payroll/runs/${runId}/calculate`, tokenAdminA, {}).expect(201);
      await waitFor(async () => {
        const row = await prisma.payrollRun.findUnique({ where: { id: runId } });
        return row && row.status === 'CALCULATED' ? row : null;
      });
      // Deliberately NOT submitted/approved/finalized — still CALCULATED.

      const { final } = await generateAndWait(branchPkDraftId, 'PK_INCOME_TAX_WITHHOLDING', 2026, 9);
      expect(final.status).toBe('FAILED');
      expect(final.errorMessage).toMatch(/no finalized payroll run/i);
    });
  });

  describe('a real PK payroll run, finalized, correctly generates each report — structure proof, not a legal-correctness assertion', () => {
    const basicSalary = 150_000;

    beforeAll(async () => {
      empPkId = (await makeEmployeeWithSalaryAndStatutoryFields(branchPkId, basicSalary, 'PKR', { CNIC: '42101-1234567-1', NTN: '9876543-1' })).id;
      await runAndFinalizePayroll(branchPkId, 2026, 6);
      await runAndFinalizePayroll(branchPkId, 2026, 7);
    });

    it('PK_INCOME_TAX_WITHHOLDING: per-employee CNIC/NTN/gross/tax-withheld, pulled from the finalized run, not recomputed', async () => {
      const { reportId, final } = await generateAndWait(branchPkId, 'PK_INCOME_TAX_WITHHOLDING', 2026, 6);
      expect(final.status).toBe('COMPLETED');

      const detail = await get(`/statutory-reports/${reportId}`, tokenAdminA).expect(200);
      expect(detail.body.summary.employeeCount).toBe(1);
      // income_tax: PROGRESSIVE_BRACKETS on annualSalary (150,000*12=1,800,000),
      // de-annualized /12 — the SAME figure benefits.e2e-spec.ts's own PK
      // payroll-run proof already hand-computes from the pack's own declared
      // brackets (see seed-country-packs.ts's PAKISTAN_PACK).
      expect(detail.body.summary.totals.taxWithheld).toBeCloseTo(10_000, 2);
      expect(detail.body.summary.totals.grossPay).toBeCloseTo(basicSalary, 2);

      const csvRes = await download(`/statutory-reports/${reportId}/download?format=csv`, tokenAdminA).expect(200);
      const csv = (csvRes.body as Buffer).toString('utf8');
      expect(csv).toContain('employee_code');
      const employee = await prisma.employee.findUniqueOrThrow({ where: { id: empPkId } });
      const row = parseCsvRow(csv, employee.employeeCode);
      expect(row).toContain('42101-1234567-1'); // CNIC
      expect(row).toContain('9876543-1'); // NTN
      expect(Number(row[row.length - 1])).toBeCloseTo(10_000, 2); // taxWithheld is the last column

      const pdfRes = await download(`/statutory-reports/${reportId}/download?format=pdf`, tokenAdminA).expect(200);
      expect((pdfRes.body as Buffer).subarray(0, 4).toString('utf8')).toBe('%PDF');
    });

    it('PK_EOBI_CONTRIBUTION: wage-ceiling-based employee+employer contributions', async () => {
      const { reportId, final } = await generateAndWait(branchPkId, 'PK_EOBI_CONTRIBUTION', 2026, 6);
      expect(final.status).toBe('COMPLETED');
      const detail = await get(`/statutory-reports/${reportId}`, tokenAdminA).expect(200);
      const eobiBase = Math.min(basicSalary, 29_000);
      expect(detail.body.summary.totals.eobiEmployee).toBeCloseTo(eobiBase * 0.01, 2);
      expect(detail.body.summary.totals.eobiEmployer).toBeCloseTo(eobiBase * 0.05, 2);
    });

    it('PK_PROVIDENT_FUND_CONTRIBUTION: employee+employer contributions', async () => {
      const { reportId, final } = await generateAndWait(branchPkId, 'PK_PROVIDENT_FUND_CONTRIBUTION', 2026, 6);
      expect(final.status).toBe('COMPLETED');
      const detail = await get(`/statutory-reports/${reportId}`, tokenAdminA).expect(200);
      expect(detail.body.summary.totals.pfEmployee).toBeCloseTo(basicSalary * 0.0833, 2);
      expect(detail.body.summary.totals.pfEmployer).toBeCloseTo(basicSalary * 0.0833, 2);
    });

    it('PK_ANNUAL_SALARY_TAX_STATEMENT: sums gross/tax withheld across every finalized month in the year — one row per employee, not one per run', async () => {
      const { reportId, final } = await generateAndWait(branchPkId, 'PK_ANNUAL_SALARY_TAX_STATEMENT', 2026);
      expect(final.status).toBe('COMPLETED');
      const detail = await get(`/statutory-reports/${reportId}`, tokenAdminA).expect(200);
      expect(detail.body.summary.employeeCount).toBe(1); // one row per employee, despite two finalized months.
      expect(detail.body.summary.totals.grossPay).toBeCloseTo(basicSalary * 2, 2);
      expect(detail.body.summary.totals.taxWithheld).toBeCloseTo(10_000 * 2, 2);
    });

    it('re-generating the SAME report/period is idempotent — one register row per (branch, report, period), not a duplicate', async () => {
      const before = await prisma.generatedReport.count({ where: { tenantId: tenantAId, branchId: branchPkId, reportCode: 'PK_INCOME_TAX_WITHHOLDING', periodKey: '2026-06' } });
      expect(before).toBe(1);
      await generateAndWait(branchPkId, 'PK_INCOME_TAX_WITHHOLDING', 2026, 6);
      const after = await prisma.generatedReport.count({ where: { tenantId: tenantAId, branchId: branchPkId, reportCode: 'PK_INCOME_TAX_WITHHOLDING', periodKey: '2026-06' } });
      expect(after).toBe(1);
    });

    it('generation is audited', async () => {
      const entry = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, entityType: 'GeneratedReport', action: 'GENERATE' }, orderBy: { occurredAt: 'desc' } });
      expect(entry).toBeTruthy();
    });

    it('a non-admin cannot generate or read reports (deny-by-default RBAC)', async () => {
      await post('/statutory-reports/generate', tokenEmployeeA, { branchId: branchPkId, reportCode: 'PK_INCOME_TAX_WITHHOLDING', periodYear: 2026, periodMonth: 6 }).expect(403);
      await get('/statutory-reports', tokenEmployeeA).expect(403);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot list or read tenant A's generated reports", async () => {
      const listRes = await get('/statutory-reports', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listRes.body.length).toBe(0);

      const report = await prisma.generatedReport.findFirstOrThrow({ where: { tenantId: tenantAId } });
      await get(`/statutory-reports/${report.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);
    });
  });
});
