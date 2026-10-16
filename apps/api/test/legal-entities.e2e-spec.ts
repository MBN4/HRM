/**
 * Proves multi-legal-entity IDENTITY (step 12.1) over real HTTP + the real DB — see
 * docs/conventions/legal-entities.md. A tenant with THREE legal entities (two PK, one QA), branches linked to
 * each: an employee's entity derives from their branch; payslips / statutory reports / offer letters carry the
 * correct entity's legal identity; Country-Pack behaviour is unchanged; a pre-existing single-entity tenant
 * (default entity, null branch link) keeps working; RBAC, field protection, encryption at rest and RLS hold.
 *
 * Requires local infra up and migrations applied (see statutory-reporting.e2e-spec.ts).
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
  seedStatutoryReportDefinitions,
  seedSystemRolesAndPermissions,
  SYSTEM_ROLES,
} from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { PayslipPdfService } from '../src/payroll/payslip/payslip-pdf.service';
import { StatutoryReportPdfService } from '../src/statutory-reporting/statutory-report-pdf.service';
import { SignableDocumentPdfService } from '../src/esignature/signable-document-pdf.service';
import { PAYROLL_RUN_ENTITY_TYPE } from '../src/payroll/payroll.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'legal-entities-test-a';
const SLUG_B = 'legal-entities-test-b';
const SLUG_LEGACY = 'legal-entities-test-legacy';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });

const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 20000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('multi-legal-entity (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let tenantLegacyId: string;
  let branchKarachi: string;
  let branchLahore: string;
  let branchDoha: string;
  let entityPk1: string;
  let entityPk2: string;
  let entityQa: string;
  let tokenAdminA: string;
  let tokenApproverA: string;
  let tokenAdminB: string;
  let tokenEmployeeA: string;
  let tokenLimitedA: string; // entity.manage but NOT salary.view
  let tokenLegacyAdmin: string;
  let legacyBranchId: string;

  const req = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    slug = SLUG_A,
  ) =>
    request(app.getHttpServer())
      [method](path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`);

  async function makeUser(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({
      data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  async function makeEmployee(
    tenantId: string,
    tokenForPatch: string,
    slug: string,
    branchId: string,
    baseSalary: number,
    currency: string,
    statutoryFields: Record<string, string>,
  ) {
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        branchId,
        employeeCode: `LE-${Math.random().toString(36).slice(2, 8)}`,
        firstName: 'Test',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
        status: 'ACTIVE',
      },
    });
    await req('patch', `/employees/${employee.id}`, tokenForPatch, slug)
      .send({ compensation: { baseSalary, salaryCurrency: currency }, statutoryFields })
      .expect(200);
    return employee;
  }

  async function runAndFinalize(branchId: string, year: number, month: number): Promise<string> {
    const create = await req('post', '/payroll/runs', tokenAdminA)
      .send({ branchId, periodYear: year, periodMonth: month })
      .expect(201);
    const runId = create.body.id as string;
    await req('post', `/payroll/runs/${runId}/calculate`, tokenAdminA).send({}).expect(201);
    await waitFor(async () =>
      (await prisma.payrollRun.findUnique({ where: { id: runId } }))?.status === 'CALCULATED'
        ? true
        : null,
    );
    await req('post', `/payroll/runs/${runId}/submit-for-approval`, tokenAdminA)
      .send({})
      .expect(201);
    const after = await req('get', `/payroll/runs/${runId}`, tokenAdminA).expect(200);
    const detail = await req(
      'get',
      `/workflow/instances/${after.body.workflowInstanceId}`,
      tokenAdminA,
    ).expect(200);
    const step = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
    await req(
      'post',
      `/workflow/instances/${after.body.workflowInstanceId}/steps/${step.id}/actions`,
      tokenApproverA,
    )
      .send({ actionType: 'APPROVE' })
      .expect(201);
    await waitFor(async () =>
      (await prisma.payrollRun.findUnique({ where: { id: runId } }))?.status === 'APPROVED'
        ? true
        : null,
    );
    await req('post', `/payroll/runs/${runId}/finalize`, tokenAdminA).send({}).expect(201);
    return runId;
  }

  async function generateReport(branchId: string, year: number, month: number) {
    const res = await req('post', '/statutory-reports/generate', tokenAdminA)
      .send({
        branchId,
        reportCode: 'PK_INCOME_TAX_WITHHOLDING',
        periodYear: year,
        periodMonth: month,
      })
      .expect(201);
    const final = await waitFor(async () => {
      const row = await prisma.generatedReport.findUnique({ where: { id: res.body.id } });
      return row && (row.status === 'COMPLETED' || row.status === 'FAILED') ? row : null;
    });
    return { id: res.body.id as string, body: res.body, final };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_LEGACY] } } });
    await seedCountryPacks(prisma);
    await seedStatutoryReportDefinitions(prisma);
    for (const [base, rate] of [
      ['PKR', '0.0036'],
      ['QAR', '0.2747'],
    ] as const) {
      await prisma.exchangeRate.upsert({
        where: {
          baseCurrency_quoteCurrency_asOfDate: {
            baseCurrency: base,
            quoteCurrency: 'USD',
            asOfDate: new Date('2026-01-01'),
          },
        },
        update: { rate },
        create: {
          baseCurrency: base,
          quoteCurrency: 'USD',
          rate,
          asOfDate: new Date('2026-01-01'),
        },
      });
    }

    const tenantA = await prisma.tenant.create({
      data: {
        name: 'Top Trending Group',
        slug: SLUG_A,
        defaultCountryCode: 'PK',
        hostingRegion: 'us-east-1',
        baseCurrencyCode: 'USD',
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: 'Other Tenant',
        slug: SLUG_B,
        defaultCountryCode: 'PK',
        hostingRegion: 'us-east-1',
      },
    });
    const tenantLegacy = await prisma.tenant.create({
      data: {
        name: 'Legacy Single Entity Co',
        slug: SLUG_LEGACY,
        defaultCountryCode: 'PK',
        hostingRegion: 'us-east-1',
        baseCurrencyCode: 'USD',
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    tenantLegacyId = tenantLegacy.id;
    for (const tenantId of [tenantAId, tenantBId, tenantLegacyId]) {
      await prisma.tenantFeatureFlagOverride.create({
        data: { tenantId, flagKey: 'multi_country_payroll', enabled: true },
      });
      await seedSystemRolesAndPermissions(prisma, tenantId);
    }

    branchKarachi = (
      await prisma.branch.create({
        data: {
          tenantId: tenantAId,
          name: 'LE Karachi',
          countryCode: 'PK',
          timezone: 'Asia/Karachi',
        },
      })
    ).id;
    branchLahore = (
      await prisma.branch.create({
        data: {
          tenantId: tenantAId,
          name: 'LE Lahore',
          countryCode: 'PK',
          timezone: 'Asia/Karachi',
        },
      })
    ).id;
    branchDoha = (
      await prisma.branch.create({
        data: { tenantId: tenantAId, name: 'LE Doha', countryCode: 'QA', timezone: 'Asia/Qatar' },
      })
    ).id;
    legacyBranchId = (
      await prisma.branch.create({
        data: {
          tenantId: tenantLegacyId,
          name: 'Legacy HQ',
          countryCode: 'PK',
          timezone: 'Asia/Karachi',
        },
      })
    ).id;

    const role = async (tenantId: string, name: string) =>
      (await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } })).id;
    const adminA = await makeUser(
      tenantAId,
      await role(tenantAId, SYSTEM_ROLES.TENANT_ADMIN),
      'admin@le-a.test',
    );
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    tokenApproverA = jwt.sign({
      sub: (
        await makeUser(
          tenantAId,
          await role(tenantAId, SYSTEM_ROLES.TENANT_ADMIN),
          'approver@le-a.test',
        )
      ).id,
      tenantId: tenantAId,
    });
    tokenEmployeeA = jwt.sign({
      sub: (
        await makeUser(tenantAId, await role(tenantAId, SYSTEM_ROLES.EMPLOYEE), 'emp@le-a.test')
      ).id,
      tenantId: tenantAId,
    });
    tokenAdminB = jwt.sign({
      sub: (
        await makeUser(
          tenantBId,
          await role(tenantBId, SYSTEM_ROLES.TENANT_ADMIN),
          'admin@le-b.test',
        )
      ).id,
      tenantId: tenantBId,
    });
    tokenLegacyAdmin = jwt.sign({
      sub: (
        await makeUser(
          tenantLegacyId,
          await role(tenantLegacyId, SYSTEM_ROLES.TENANT_ADMIN),
          'admin@le-legacy.test',
        )
      ).id,
      tenantId: tenantLegacyId,
    });

    // A custom role holding entity.manage but NOT salary.view (proves the bank-details field gate).
    const limitedRole = await prisma.role.create({
      data: { tenantId: tenantAId, name: 'ENTITY_ONLY', isSystem: false },
    });
    const entityPerm = await prisma.permission.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: tenantAId, key: 'entity.manage' } },
    });
    await prisma.rolePermission.create({
      data: { tenantId: tenantAId, roleId: limitedRole.id, permissionId: entityPerm.id },
    });
    tokenLimitedA = jwt.sign({
      sub: (await makeUser(tenantAId, limitedRole.id, 'limited@le-a.test')).id,
      tenantId: tenantAId,
    });

    const template = await prisma.workflowTemplate.create({
      data: {
        tenantId: tenantAId,
        name: 'Payroll Run Approval',
        entityType: PAYROLL_RUN_ENTITY_TYPE,
        version: 1,
        isActive: true,
      },
    });
    await prisma.workflowStep.create({
      data: {
        tenantId: tenantAId,
        templateId: template.id,
        name: 'Admin approval',
        order: 1,
        approverRule: { type: 'ROLE', roleName: SYSTEM_ROLES.TENANT_ADMIN },
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_LEGACY] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('entity admin (entity.manage), country labels, bank-detail protection', () => {
    it('creates three entities; the first one a tenant ever gets becomes its default; labels come from the Country Pack', async () => {
      const pk1 = await req('post', '/legal-entities', tokenAdminA)
        .send({
          legalName: 'Top Trending Pvt Ltd',
          countryCode: 'pk',
          registrationNumber: 'SECP-0012345',
          taxId: '1234567-8',
          addressLine1: '12 Clifton Road',
          city: 'Karachi',
          region: 'Sindh',
          postalCode: '75600',
          bankDetails: {
            bankName: 'HBL',
            accountNumber: 'PK36HABB0000123456789012',
            routingCode: 'HABBPKKA',
          },
        })
        .expect(201);
      entityPk1 = pk1.body.id;
      expect(pk1.body.isDefault).toBe(true);
      expect(pk1.body.countryCode).toBe('PK');
      expect(pk1.body.registrationNumberLabel).toBe('SECP Company Registration No.');
      expect(pk1.body.taxIdLabel).toBe('NTN (National Tax Number)');

      // A fresh tenant provisioned straight through prisma has no default yet, so pk1 is it; the rest are not.
      entityPk2 = (
        await req('post', '/legal-entities', tokenAdminA)
          .send({
            legalName: 'Top Trending Logistics (Pvt) Ltd',
            countryCode: 'PK',
            registrationNumber: 'SECP-0067890',
            taxId: '7654321-0',
            addressLine1: '5 Gulberg',
            city: 'Lahore',
          })
          .expect(201)
      ).body.id;
      const qa = await req('post', '/legal-entities', tokenAdminA)
        .send({
          legalName: 'Top Trending LLC',
          countryCode: 'QA',
          registrationNumber: 'CR-4455',
          taxId: 'TC-9911',
          addressLine1: 'West Bay Tower',
          city: 'Doha',
        })
        .expect(201);
      entityQa = qa.body.id;
      expect(qa.body.isDefault).toBe(false);
      expect(qa.body.registrationNumberLabel).toBe('Commercial Registration (CR) No.');
      expect(qa.body.taxIdLabel).toBe('Tax Card No.');
    });

    it("assigns branches to entities and lists the entity's employees DERIVED from their branch", async () => {
      await req('put', `/legal-entities/${entityPk1}/branches`, tokenAdminA)
        .send({ branchIds: [branchKarachi] })
        .expect(200);
      await req('put', `/legal-entities/${entityPk2}/branches`, tokenAdminA)
        .send({ branchIds: [branchLahore] })
        .expect(200);
      const qaRes = await req('put', `/legal-entities/${entityQa}/branches`, tokenAdminA)
        .send({ branchIds: [branchDoha] })
        .expect(200);
      expect(qaRes.body.branches).toEqual([
        expect.objectContaining({ id: branchDoha, countryCode: 'QA' }),
      ]);

      const karachiEmp = await prisma.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branchKarachi,
          employeeCode: 'LE-DERIVE-1',
          firstName: 'Kara',
          lastName: 'Chi',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2020-01-01'),
          status: 'ACTIVE',
        },
      });
      const lahoreEmp = await prisma.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branchLahore,
          employeeCode: 'LE-DERIVE-2',
          firstName: 'La',
          lastName: 'Hore',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2020-01-01'),
          status: 'ACTIVE',
        },
      });
      const pk1Emps = await req(
        'get',
        `/legal-entities/${entityPk1}/employees`,
        tokenAdminA,
      ).expect(200);
      expect(pk1Emps.body.map((e: { id: string }) => e.id)).toContain(karachiEmp.id);
      expect(pk1Emps.body.map((e: { id: string }) => e.id)).not.toContain(lahoreEmp.id);
      const pk2Emps = await req(
        'get',
        `/legal-entities/${entityPk2}/employees`,
        tokenAdminA,
      ).expect(200);
      expect(pk2Emps.body.map((e: { id: string }) => e.id)).toEqual([lahoreEmp.id]);
    });

    it('assigning a branch from another tenant is rejected, and a branch belongs to exactly one entity (assigning moves it)', async () => {
      const foreign = await prisma.branch.create({
        data: {
          tenantId: tenantBId,
          name: 'LE B Branch',
          countryCode: 'PK',
          timezone: 'Asia/Karachi',
        },
      });
      await req('put', `/legal-entities/${entityPk1}/branches`, tokenAdminA)
        .send({ branchIds: [foreign.id] })
        .expect(400);
      const rows = await prisma.branch.findMany({
        where: { tenantId: tenantAId, legalEntityId: { in: [entityPk1, entityPk2, entityQa] } },
      });
      expect(rows).toHaveLength(3);
    });

    it('bank details are encrypted at rest, returned only MASKED, and OMITTED for a caller without salary.view', async () => {
      const row = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityPk1 } });
      expect(row.bankAccountNumberEncrypted).toBeTruthy();
      expect(row.bankAccountNumberEncrypted).not.toContain('PK36HABB');
      expect(row.bankNameEncrypted).not.toContain('HBL');

      const full = await req('get', `/legal-entities/${entityPk1}`, tokenAdminA).expect(200);
      expect(full.body.bankDetails).toEqual({
        bankName: 'HBL',
        accountNumberMasked: '••••9012',
        routingCodeMasked: '••••PKKA',
      });
      expect(JSON.stringify(full.body)).not.toContain('PK36HABB0000123456789012');

      const limited = await req('get', `/legal-entities/${entityPk1}`, tokenLimitedA).expect(200);
      expect(limited.body.hasBankDetails).toBe(true);
      expect(limited.body).not.toHaveProperty('bankDetails');
    });

    it('is RBAC-gated: an employee is refused, and entity writes are audited', async () => {
      await req('get', '/legal-entities', tokenEmployeeA).expect(403);
      await req('post', '/legal-entities', tokenEmployeeA)
        .send({ legalName: 'Nope', countryCode: 'PK' })
        .expect(403);
      const audit = await waitFor(async () => {
        const rows = await prisma.auditLog.findMany({
          where: { tenantId: tenantAId, entityType: 'LegalEntity' },
        });
        return rows.length >= 3 ? rows : null;
      });
      expect(audit.some((a) => a.action === 'CREATE')).toBe(true);
      // The audit sink redacts the sensitive bank/tax values.
      expect(JSON.stringify(audit)).not.toContain('PK36HABB0000123456789012');
    });

    it("is tenant-isolated: another tenant cannot see, edit or fetch this tenant's entities (RLS + scoping)", async () => {
      const list = await req('get', '/legal-entities', tokenAdminB, SLUG_B).expect(200);
      expect(list.body.map((e: { id: string }) => e.id)).not.toContain(entityPk1);
      await req('get', `/legal-entities/${entityPk1}`, tokenAdminB, SLUG_B).expect(404);
      await req('patch', `/legal-entities/${entityPk1}`, tokenAdminB, SLUG_B)
        .send({ legalName: 'Hijack' })
        .expect(404);
      // Straight at the DB under tenant B's RLS context:
      const rows = await appPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`select set_config('app.current_tenant', '${tenantBId}', true)`);
        return tx.legalEntity.findMany({ where: { id: entityPk1 } });
      });
      expect(rows).toHaveLength(0);
    });

    it('refuses to delete the default entity or one still referenced by branches', async () => {
      await req('delete', `/legal-entities/${entityPk1}`, tokenAdminA).expect(409);
      await req('delete', `/legal-entities/${entityQa}`, tokenAdminA).expect(409);
    });
  });

  describe('payslips carry the correct legal entity (and Country-Pack behaviour is unchanged)', () => {
    let pkRunId: string;
    let qaRunId: string;
    let pkEmpId: string;
    let qaEmpId: string;

    it("a PK employee's payslip prints PK entity identity; a QA employee's prints the QA entity; currency/pack unchanged", async () => {
      pkEmpId = (
        await makeEmployee(tenantAId, tokenAdminA, SLUG_A, branchKarachi, 150_000, 'PKR', {
          CNIC: '42101-1234567-1',
          NTN: '9876543-1',
        })
      ).id;
      qaEmpId = (
        await makeEmployee(tenantAId, tokenAdminA, SLUG_A, branchDoha, 9_000, 'QAR', {
          QATAR_ID: '29001234567',
          VISA_SPONSORSHIP: 'company',
        })
      ).id;

      const pdf = moduleRef.get(PayslipPdfService);
      const spy = jest.spyOn(pdf, 'render');

      for (const [branchId, key] of [
        [branchKarachi, 'pk'],
        [branchDoha, 'qa'],
      ] as const) {
        const create = await req('post', '/payroll/runs', tokenAdminA)
          .send({ branchId, periodYear: 2026, periodMonth: 3 })
          .expect(201);
        if (key === 'pk') pkRunId = create.body.id;
        else qaRunId = create.body.id;
        await req('post', `/payroll/runs/${create.body.id}/calculate`, tokenAdminA)
          .send({})
          .expect(201);
        await waitFor(async () =>
          (await prisma.payrollRun.findUnique({ where: { id: create.body.id } }))?.status ===
          'CALCULATED'
            ? true
            : null,
        );
      }

      // The run is ATTRIBUTED to its entity (stamped at creation + surfaced in the response).
      const pkRun = await req('get', `/payroll/runs/${pkRunId}`, tokenAdminA).expect(200);
      expect(pkRun.body.legalEntity).toMatchObject({
        id: entityPk1,
        legalName: 'Top Trending Pvt Ltd',
        registrationNumber: 'SECP-0012345',
      });
      expect(
        (await prisma.payrollRun.findUniqueOrThrow({ where: { id: pkRunId } })).legalEntityId,
      ).toBe(entityPk1);
      const qaRun = await req('get', `/payroll/runs/${qaRunId}`, tokenAdminA).expect(200);
      expect(qaRun.body.legalEntity).toMatchObject({ id: entityQa, legalName: 'Top Trending LLC' });
      // Country Pack unchanged: the branch's own country still drives currency.
      expect(pkRun.body.currencyCode).toBe('PKR');
      expect(qaRun.body.currencyCode).toBe('QAR');

      const dl = (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Host', hostFor(SLUG_A))
          .set('Authorization', `Bearer ${tokenAdminA}`)
          .buffer(true)
          .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
          });
      const pkSlip = await dl(`/payroll/runs/${pkRunId}/payslips/${pkEmpId}`).expect(200);
      expect((pkSlip.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const qaSlip = await dl(`/payroll/runs/${qaRunId}/payslips/${qaEmpId}`).expect(200);
      expect((qaSlip.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const inputs = spy.mock.calls.map((c) => c[0]);
      const pkInput = inputs.find((i) => i.currencyCode === 'PKR')!;
      const qaInput = inputs.find((i) => i.currencyCode === 'QAR')!;
      expect(pkInput.employer).toMatchObject({
        legalName: 'Top Trending Pvt Ltd',
        registrationNumber: 'SECP-0012345',
        taxId: '1234567-8',
        registrationNumberLabel: 'SECP Company Registration No.',
        addressLines: ['12 Clifton Road', 'Karachi, Sindh 75600'],
      });
      expect(JSON.stringify(pkInput.employer)).not.toContain('PK36HABB'); // a document never carries bank details
      expect(qaInput.employer).toMatchObject({
        legalName: 'Top Trending LLC',
        registrationNumber: 'CR-4455',
        taxIdLabel: 'Tax Card No.',
      });
      spy.mockRestore();
    });
  });

  describe('statutory reports are generated FOR a specific entity', () => {
    it('two entities produce separate, correctly-labelled reports (register stamp, filter, PDF filer block)', async () => {
      await makeEmployee(tenantAId, tokenAdminA, SLUG_A, branchLahore, 120_000, 'PKR', {
        CNIC: '35202-7654321-0',
        NTN: '1111111-1',
      });
      await runAndFinalize(branchKarachi, 2026, 6);
      await runAndFinalize(branchLahore, 2026, 6);

      const pdf = moduleRef.get(StatutoryReportPdfService);
      const spy = jest.spyOn(pdf, 'render');

      const r1 = await generateReport(branchKarachi, 2026, 6);
      const r2 = await generateReport(branchLahore, 2026, 6);
      expect(r1.final.status).toBe('COMPLETED');
      expect(r2.final.status).toBe('COMPLETED');
      expect(r1.final.legalEntityId).toBe(entityPk1);
      expect(r2.final.legalEntityId).toBe(entityPk2);
      expect(r1.body.legalEntity).toMatchObject({
        legalName: 'Top Trending Pvt Ltd',
        registrationNumber: 'SECP-0012345',
      });

      const filers = spy.mock.calls.map((c) => c[0].legalEntity?.legalName);
      expect(filers).toEqual(
        expect.arrayContaining(['Top Trending Pvt Ltd', 'Top Trending Logistics (Pvt) Ltd']),
      );
      const input1 = spy.mock.calls.map((c) => c[0]).find((i) => i.legalEntity?.id === entityPk1)!;
      expect(input1.legalEntity).toMatchObject({
        registrationNumber: 'SECP-0012345',
        taxId: '1234567-8',
        taxIdLabel: 'NTN (National Tax Number)',
      });
      spy.mockRestore();

      // Per-entity filtering of the register.
      const only1 = await req(
        'get',
        `/statutory-reports?legalEntityId=${entityPk1}`,
        tokenAdminA,
      ).expect(200);
      expect(only1.body.map((r: { id: string }) => r.id)).toEqual([r1.id]);
      const only2 = await req(
        'get',
        `/statutory-reports?legalEntityId=${entityPk2}`,
        tokenAdminA,
      ).expect(200);
      expect(only2.body.map((r: { id: string }) => r.id)).toEqual([r2.id]);
      await req('get', '/statutory-reports?legalEntityId=not-a-uuid', tokenAdminA).expect(400);
    });
  });

  describe('contracts / offer letters name the correct employing entity', () => {
    it('an offer letter generated for a Lahore-branch offer carries the Lahore entity; a Doha one the QA entity', async () => {
      const spy = jest.spyOn(moduleRef.get(SignableDocumentPdfService), 'renderTextDocument');
      const candidate = await prisma.candidate.create({
        data: {
          tenantId: tenantAId,
          firstName: 'Cand',
          lastName: 'Idate',
          email: 'cand@le-candidates.test',
        },
      });
      const admin = await prisma.user.findFirstOrThrow({
        where: { tenantId: tenantAId, email: 'admin@le-a.test' },
      });
      for (const [branchId, expected] of [
        [branchLahore, 'Top Trending Logistics (Pvt) Ltd'],
        [branchDoha, 'Top Trending LLC'],
      ] as const) {
        const requisition = await prisma.jobRequisition.create({
          data: {
            tenantId: tenantAId,
            title: 'Role',
            branchId,
            employmentType: 'FULL_TIME',
            status: 'APPROVED',
            createdByUserId: admin.id,
          },
        });
        const posting = await prisma.jobPosting.create({
          data: {
            tenantId: tenantAId,
            requisitionId: requisition.id,
            title: 'Role',
            description: 'd',
            publicSlug: `le-${branchId.slice(0, 8)}`,
            status: 'PUBLISHED',
          },
        });
        const application = await prisma.application.create({
          data: { tenantId: tenantAId, candidateId: candidate.id, jobPostingId: posting.id },
        });
        const offer = await prisma.offer.create({
          data: {
            tenantId: tenantAId,
            applicationId: application.id,
            branchId,
            employmentType: 'FULL_TIME',
            proposedSalary: '5000',
            salaryCurrency: 'PKR',
            proposedJoinDate: new Date('2026-12-01'),
            status: 'APPROVED',
            createdByUserId: admin.id,
          },
        });
        await req('post', '/e-signatures/requests', tokenAdminA)
          .send({
            generate: { kind: 'OFFER_LETTER', offerId: offer.id },
            signers: [
              {
                signerType: 'EXTERNAL',
                order: 0,
                externalName: 'Cand Idate',
                externalEmail: 'cand@le-candidates.test',
              },
            ],
          })
          .expect(201);
        const call = spy.mock.calls
          .map((c) => c[0])
          .find((i) => i.paragraphs.some((p) => p === `Employer: ${expected}`));
        expect(call).toBeDefined();
        expect(call!.paragraphs.join('\n')).toContain(expected);
      }
      spy.mockRestore();
    });
  });

  describe('migration: an existing single-entity tenant keeps working', () => {
    it('a tenant whose branch has NO explicit link resolves to its default entity; payslip + report still generate', async () => {
      // Simulate a pre-12.1 tenant exactly as the migration leaves it: one default entity (from the tenant's own details), a branch.
      const def = await prisma.legalEntity.create({
        data: {
          tenantId: tenantLegacyId,
          legalName: 'Legacy Single Entity Co',
          countryCode: 'PK',
          isDefault: true,
        },
      });
      expect(
        (await prisma.branch.findUniqueOrThrow({ where: { id: legacyBranchId } })).legalEntityId,
      ).toBeNull();

      const list = await req('get', '/legal-entities', tokenLegacyAdmin, SLUG_LEGACY).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id: def.id,
        isDefault: true,
        branchCount: 1,
        registrationNumberLabel: 'SECP Company Registration No.',
      });
      const detail = await req(
        'get',
        `/legal-entities/${def.id}`,
        tokenLegacyAdmin,
        SLUG_LEGACY,
      ).expect(200);
      expect(detail.body.branches).toEqual([expect.objectContaining({ id: legacyBranchId })]); // a null link shows under the default entity

      // Payroll + payslip still work and attribute to the default entity.
      const emp = await prisma.employee.create({
        data: {
          tenantId: tenantLegacyId,
          branchId: legacyBranchId,
          employeeCode: 'LEG-1',
          firstName: 'Old',
          lastName: 'Timer',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2020-01-01'),
          status: 'ACTIVE',
        },
      });
      await req('patch', `/employees/${emp.id}`, tokenLegacyAdmin, SLUG_LEGACY)
        .send({
          compensation: { baseSalary: 100_000, salaryCurrency: 'PKR' },
          statutoryFields: { CNIC: '1', NTN: '2' },
        })
        .expect(200);
      const spy = jest.spyOn(moduleRef.get(PayslipPdfService), 'render');
      const run = await req('post', '/payroll/runs', tokenLegacyAdmin, SLUG_LEGACY)
        .send({ branchId: legacyBranchId, periodYear: 2026, periodMonth: 2 })
        .expect(201);
      expect(run.body.legalEntity).toMatchObject({ id: def.id });
      await req('post', `/payroll/runs/${run.body.id}/calculate`, tokenLegacyAdmin, SLUG_LEGACY)
        .send({})
        .expect(201);
      await waitFor(async () =>
        (await prisma.payrollRun.findUnique({ where: { id: run.body.id } }))?.status ===
        'CALCULATED'
          ? true
          : null,
      );
      await req(
        'get',
        `/payroll/runs/${run.body.id}/payslips/${emp.id}`,
        tokenLegacyAdmin,
        SLUG_LEGACY,
      ).expect(200);
      expect(spy.mock.calls.at(-1)![0].employer).toMatchObject({
        legalName: 'Legacy Single Entity Co',
        id: def.id,
      });
      spy.mockRestore();
    });

    it("the migration's backfill SQL creates one default entity per tenant, links its branches, and is idempotent", async () => {
      // A pre-12.1-shaped tenant: branches, no legal entity at all.
      const t = await prisma.tenant.create({
        data: {
          name: 'Pre Migration Co',
          slug: 'legal-entities-test-premig',
          defaultCountryCode: 'QA',
          hostingRegion: 'us-east-1',
        },
      });
      try {
        const b1 = await prisma.branch.create({
          data: { tenantId: t.id, name: 'Old Doha', countryCode: 'QA', timezone: 'Asia/Qatar' },
        });
        const b2 = await prisma.branch.create({
          data: { tenantId: t.id, name: 'Old Dubai', countryCode: 'AE', timezone: 'Asia/Dubai' },
        });
        // The two backfill statements, verbatim from 20261017090100_enable_rls_for_legal_entities (scoped to this tenant).
        const backfill = async () => {
          await prisma.$executeRawUnsafe(`INSERT INTO "legal_entities" ("id","tenant_id","legal_name","country_code","is_default","created_at","updated_at")
            SELECT gen_random_uuid(), t."id", t."name", t."default_country_code", true, now(), now() FROM "tenants" t
            WHERE t."id" = '${t.id}'::uuid AND NOT EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."tenant_id" = t."id" AND e."is_default" = true)`);
          await prisma.$executeRawUnsafe(`UPDATE "branches" b SET "legal_entity_id" = e."id" FROM "legal_entities" e
            WHERE e."tenant_id" = b."tenant_id" AND e."is_default" = true AND b."legal_entity_id" IS NULL AND b."tenant_id" = '${t.id}'::uuid`);
        };
        await backfill();
        await backfill();
        const entities = await prisma.legalEntity.findMany({ where: { tenantId: t.id } });
        expect(entities).toHaveLength(1);
        expect(entities[0]).toMatchObject({
          legalName: 'Pre Migration Co',
          countryCode: 'QA',
          isDefault: true,
        });
        const branches = await prisma.branch.findMany({ where: { id: { in: [b1.id, b2.id] } } });
        expect(branches.every((b) => b.legalEntityId === entities[0].id)).toBe(true);
        // Each branch's own country is untouched — identity layer only.
        expect(branches.map((b) => b.countryCode).sort()).toEqual(['AE', 'QA']);
        // The DB refuses a second default entity for the same tenant.
        await expect(
          prisma.legalEntity.create({
            data: { tenantId: t.id, legalName: 'Second', countryCode: 'QA', isDefault: true },
          }),
        ).rejects.toThrow();
      } finally {
        await prisma.tenant.delete({ where: { id: t.id } });
      }
    });
  });
});
