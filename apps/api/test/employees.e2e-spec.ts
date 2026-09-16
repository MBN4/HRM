/**
 * Proves the Employee module (step 1.1, Phase 1) end to end over real HTTP
 * — see docs/conventions/employee.md: CRUD with RBAC + branch scoping,
 * cross-tenant isolation (RLS), field-level salary gating, encryption at
 * rest, country-driven required statutory fields (same code path, US vs.
 * QA), custom fields round-tripping through the employee API, the Employee
 * org chart feeding 0.7's MANAGER approver rule for real, bulk CSV import
 * (async, row-level validated), and the org chart endpoint.
 *
 * A JWT is minted directly (bypassing the real login flow, exercised in
 * full by auth-rbac.e2e-spec.ts) — same rationale every other e2e suite in
 * this codebase already documents for doing the same thing.
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
} from '@hrm/db';
import { ApproverRule } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'emp-test-tenant-a';
const TENANT_B_SLUG = 'emp-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 10000, intervalMs = 150): Promise<T> {
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

const MANAGER: ApproverRule = { type: 'MANAGER' };

describe('employees (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;

  let branchAUsId: string;
  let branchAQaId: string;
  let deptAEngId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenEmployeeA: string;
  let tokenBranchRestrictedHrA: string;
  let tokenAdminB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Employee Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Employee Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchAUs = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A US HQ', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchAUsId = branchAUs.id;
    const branchAQa = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'A Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchAQaId = branchAQa.id;
    const deptAEng = await prisma.department.create({
      data: { tenantId: tenantAId, branchId: branchAUsId, name: 'Engineering' },
    });
    deptAEngId = deptAEng.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const hrRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } },
    });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminRoleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    async function makeUser(tenantId: string, email: string, roleId: string) {
      const user = await prisma.user.create({
        data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
      return user;
    }

    const adminA = await makeUser(tenantAId, 'admin@emp-a.test', adminRoleA.id);
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const hrA = await makeUser(tenantAId, 'hr@emp-a.test', hrRoleA.id);
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });

    const employeeUserA = await makeUser(tenantAId, 'employee-role@emp-a.test', employeeRoleA.id);
    tokenEmployeeA = jwt.sign({ sub: employeeUserA.id, tenantId: tenantAId });

    const branchRestrictedHrA = await makeUser(tenantAId, 'branch-restricted-hr@emp-a.test', hrRoleA.id);
    await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: branchRestrictedHrA.id, branchId: branchAUsId } });
    tokenBranchRestrictedHrA = jwt.sign({ sub: branchRestrictedHrA.id, tenantId: tenantAId });

    const adminB = await makeUser(tenantBId, 'admin@emp-b.test', adminRoleB.id);
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      .post(path)
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }

  function patch(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      .patch(path)
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  let usCounter = 0;
  function usEmployeePayload(overrides: Record<string, unknown> = {}) {
    usCounter += 1;
    return {
      employeeCode: `US-${usCounter}`,
      firstName: 'Jane',
      lastName: 'Doe',
      branchId: branchAUsId,
      employmentType: 'FULL_TIME',
      joinDate: '2024-01-15',
      statutoryFields: { SSN: '123-45-6789', W4: 'on-file' },
      ...overrides,
    };
  }

  describe('CRUD with RBAC + branch scoping', () => {
    it('rejects create without employee.write (deny-by-default)', async () => {
      await post('/employees', tokenEmployeeA, usEmployeePayload()).expect(403);
    });

    it('an HR_MANAGER can create, read, list, and update an employee', async () => {
      const createRes = await post('/employees', tokenHrA, usEmployeePayload({ departmentId: deptAEngId })).expect(201);
      const id = createRes.body.id;
      expect(createRes.body.firstName).toBe('Jane');
      expect(createRes.body.branchId).toBe(branchAUsId);
      expect(createRes.body.departmentId).toBe(deptAEngId);

      const getRes = await get(`/employees/${id}`, tokenHrA).expect(200);
      expect(getRes.body.id).toBe(id);

      const listRes = await get('/employees', tokenHrA).expect(200);
      expect(listRes.body.data.some((e: { id: string }) => e.id === id)).toBe(true);
      expect(listRes.body.total).toBeGreaterThanOrEqual(1);

      const patchRes = await patch(`/employees/${id}`, tokenHrA, { lastName: 'Smith' }).expect(200);
      expect(patchRes.body.lastName).toBe('Smith');
      expect(patchRes.body.firstName).toBe('Jane');
    });

    it('rejects a branch-restricted caller creating an employee outside their allowed branches', async () => {
      await post('/employees', tokenBranchRestrictedHrA, usEmployeePayload({ branchId: branchAQaId, statutoryFields: { QATAR_ID: 'x', VISA_SPONSORSHIP: 'y' } })).expect(403);
    });

    it('a branch-restricted caller can create within their allowed branch, and cannot see an employee outside it', async () => {
      const createRes = await post('/employees', tokenBranchRestrictedHrA, usEmployeePayload()).expect(201);
      expect(createRes.body.branchId).toBe(branchAUsId);

      const qaEmployee = await post(
        '/employees',
        tokenAdminA,
        usEmployeePayload({ branchId: branchAQaId, statutoryFields: { QATAR_ID: 'qid-1', VISA_SPONSORSHIP: 'yes' } }),
      ).expect(201);

      await get(`/employees/${qaEmployee.body.id}`, tokenBranchRestrictedHrA).expect(404);

      const listRes = await get('/employees', tokenBranchRestrictedHrA).expect(200);
      expect(listRes.body.data.every((e: { branchId: string }) => e.branchId === branchAUsId)).toBe(true);
    });
  });

  describe('field-level permission: salary.view', () => {
    it('HR_MANAGER (has salary.view) sees compensation; EMPLOYEE role (no salary.view) has it omitted, not nulled', async () => {
      const createRes = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({ compensation: { baseSalary: 95000, salaryCurrency: 'USD' } }),
      ).expect(201);
      const id = createRes.body.id;
      expect(createRes.body.compensation).toEqual({ baseSalary: 95000, salaryCurrency: 'USD' });

      const asHr = await get(`/employees/${id}`, tokenHrA).expect(200);
      expect(asHr.body.compensation).toEqual({ baseSalary: 95000, salaryCurrency: 'USD' });

      const asEmployee = await get(`/employees/${id}`, tokenEmployeeA).expect(200);
      expect('compensation' in asEmployee.body).toBe(false);
      // bankDetails is not field-gated (only salary was asked to be).
      expect('bankDetails' in asEmployee.body).toBe(true);
    });
  });

  describe('GET /employees/me — step 1.4 ESS: resolving the caller\'s own employee record', () => {
    it('404s when the caller has no linked Employee record', async () => {
      await get('/employees/me', tokenEmployeeA).expect(404);
    });

    it('returns the caller\'s own profile, still field-gated by salary.view, regardless of who created it', async () => {
      const selfUser = await prisma.user.create({
        data: { tenantId: tenantAId, email: `self-${++usCounter}@emp-a.test`, hashedPassword: 'unused', status: 'ACTIVE' },
      });
      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: selfUser.id, roleId: employeeRoleA.id } });
      const selfToken = jwt.sign({ sub: selfUser.id, tenantId: tenantAId });

      const createRes = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({ userId: selfUser.id, compensation: { baseSalary: 60000, salaryCurrency: 'USD' } }),
      ).expect(201);

      const meRes = await get('/employees/me', selfToken).expect(200);
      expect(meRes.body.id).toBe(createRes.body.id);
      expect(meRes.body.userId).toBe(selfUser.id);
      expect('compensation' in meRes.body).toBe(false);
    });
  });

  describe('encryption at rest', () => {
    it('bank details and salary are stored encrypted, not plaintext, in the database', async () => {
      const plainAccountNumber = '000123456789';
      const createRes = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({
          bankDetails: { accountNumber: plainAccountNumber, bankName: 'First National', routingCode: '021000021' },
          compensation: { baseSalary: 120000, salaryCurrency: 'USD' },
        }),
      ).expect(201);
      const id = createRes.body.id;

      expect(createRes.body.bankDetails.accountNumber).toBe(plainAccountNumber);
      expect(createRes.body.compensation.baseSalary).toBe(120000);

      const row = await prisma.employee.findUniqueOrThrow({ where: { id } });
      expect(row.bankAccountNumberEncrypted).not.toBeNull();
      expect(row.bankAccountNumberEncrypted).not.toContain(plainAccountNumber);
      // Step 6.2 — ciphertext is now version-prefixed ("v<version>:<iv>:<authTag>:<data>",
      // 4 colon-separated segments) to support field-encryption key rotation
      // — see EncryptionService's own doc comment. Still never the plaintext.
      expect(row.bankAccountNumberEncrypted!.split(':')).toHaveLength(4);
      expect(row.baseSalaryEncrypted).not.toBeNull();
      expect(row.baseSalaryEncrypted).not.toContain('120000');
      expect(row.baseSalaryEncrypted!.split(':')).toHaveLength(4);
    });
  });

  describe('country-driven required fields — same code path, different pack', () => {
    it('a US branch employee requires SSN and W4', async () => {
      const res = await post('/employees', tokenHrA, usEmployeePayload({ statutoryFields: {} })).expect(400);
      expect(res.body.message).toMatch(/SSN/);
      expect(res.body.message).toMatch(/W4/);

      await post('/employees', tokenHrA, usEmployeePayload()).expect(201);
    });

    it('a QA branch employee requires QATAR_ID and VISA_SPONSORSHIP', async () => {
      const qaPayload = {
        employeeCode: `QA-${++usCounter}`,
        firstName: 'Amal',
        lastName: 'Al-Thani',
        branchId: branchAQaId,
        employmentType: 'FULL_TIME',
        joinDate: '2024-02-01',
      };

      const missing = await post('/employees', tokenHrA, { ...qaPayload, statutoryFields: { QATAR_ID: 'q-1' } }).expect(400);
      expect(missing.body.message).toMatch(/VISA_SPONSORSHIP/);

      const ok = await post('/employees', tokenHrA, {
        ...qaPayload,
        statutoryFields: { QATAR_ID: 'q-1', VISA_SPONSORSHIP: 'sponsored' },
      }).expect(201);
      expect(ok.body.statutoryFields).toEqual({ QATAR_ID: 'q-1', VISA_SPONSORSHIP: 'sponsored' });
    });
  });

  describe('custom fields — validate + round-trip', () => {
    beforeAll(async () => {
      await post('/custom-fields/definitions', tokenAdminA, {
        entityType: 'Employee',
        fieldKey: 'shirt_size',
        label: 'Shirt size',
        fieldType: 'ENUM',
        options: ['S', 'M', 'L'],
      }).expect(201);
    });

    it('rejects an out-of-options ENUM custom field value', async () => {
      await post('/employees', tokenHrA, usEmployeePayload({ customFields: { shirt_size: 'XXL' } })).expect(400);
    });

    it('accepts a valid custom field value and round-trips it via GET, and via update', async () => {
      const createRes = await post('/employees', tokenHrA, usEmployeePayload({ customFields: { shirt_size: 'M' } })).expect(
        201,
      );
      expect(createRes.body.customFields).toEqual({ shirt_size: 'M' });

      const id = createRes.body.id;
      const getRes = await get(`/employees/${id}`, tokenHrA).expect(200);
      expect(getRes.body.customFields).toEqual({ shirt_size: 'M' });

      const patchRes = await patch(`/employees/${id}`, tokenHrA, { customFields: { shirt_size: 'L' } }).expect(200);
      expect(patchRes.body.customFields).toEqual({ shirt_size: 'L' });
    });
  });

  describe('manager relation feeds the workflow engine\'s MANAGER approver rule', () => {
    let managerToken: string;
    let subordinateToken: string;

    beforeAll(async () => {
      const template = await prisma.workflowTemplate.create({
        data: {
          tenantId: tenantAId,
          name: 'EMPLOYEE_MANAGER_TEST',
          entityType: 'EMPLOYEE_MANAGER_TEST',
          version: 1,
          isActive: true,
        },
      });
      await prisma.workflowStep.create({
        data: { tenantId: tenantAId, templateId: template.id, name: 'Manager approval', order: 1, approverRule: MANAGER },
      });

      const employeeRoleA = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
      });
      const managerUser = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'org-manager@emp-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: managerUser.id, roleId: employeeRoleA.id } });
      managerToken = jwt.sign({ sub: managerUser.id, tenantId: tenantAId });

      const subordinateUser = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'org-subordinate@emp-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: subordinateUser.id, roleId: employeeRoleA.id } });
      subordinateToken = jwt.sign({ sub: subordinateUser.id, tenantId: tenantAId });

      const managerEmployee = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({ userId: managerUser.id, employeeCode: `MGR-${++usCounter}` }),
      ).expect(201);

      await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({
          userId: subordinateUser.id,
          managerId: managerEmployee.body.id,
          employeeCode: `SUB-${++usCounter}`,
        }),
      ).expect(201);
    });

    it("resolves the real manager (not just the legacy User.managerId seam) as the eligible approver", async () => {
      const startRes = await post('/workflow/instances', subordinateToken, {
        entityType: 'EMPLOYEE_MANAGER_TEST',
        entityId: 'leave-1',
        dataSnapshot: {},
      }).expect(201);
      const instanceId = startRes.body.id;

      const detailRes = await get(`/workflow/instances/${instanceId}`, managerToken).expect(200);
      const activeStep = detailRes.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');
      expect(activeStep.eligibleApproverIds).toContain((await prisma.user.findFirstOrThrow({ where: { email: 'org-manager@emp-a.test' } })).id);

      const approveRes = await post(
        `/workflow/instances/${instanceId}/steps/${activeStep.id}/actions`,
        managerToken,
        { actionType: 'APPROVE' },
      ).expect(201);
      expect(approveRes.body.status).toBe('APPROVED');
    });
  });

  describe('org chart', () => {
    it('reflects the reporting hierarchy derived from Employee.managerId', async () => {
      const managerRes = await post('/employees', tokenHrA, usEmployeePayload({ employeeCode: `OC-MGR-${++usCounter}` })).expect(
        201,
      );
      const reportARes = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({ employeeCode: `OC-A-${++usCounter}`, managerId: managerRes.body.id }),
      ).expect(201);
      const reportBRes = await post(
        '/employees',
        tokenHrA,
        usEmployeePayload({ employeeCode: `OC-B-${++usCounter}`, managerId: managerRes.body.id }),
      ).expect(201);

      const chartRes = await get(`/employees/org-chart?branchId=${branchAUsId}`, tokenHrA).expect(200);
      const managerNode = chartRes.body.find((node: { id: string }) => node.id === managerRes.body.id);
      expect(managerNode).toBeDefined();
      const reportIds = managerNode.directReports.map((n: { id: string }) => n.id);
      expect(reportIds).toEqual(expect.arrayContaining([reportARes.body.id, reportBRes.body.id]));
    });
  });

  describe('bulk import — async, row-level validated, with an error report', () => {
    it('processes valid rows and reports errors for invalid ones, without blocking the request', async () => {
      const code1 = `BULK-${++usCounter}`;
      const code2 = `BULK-${++usCounter}`;
      const csvContent = [
        'employeeCode,firstName,lastName,branchId,employmentType,joinDate,statutoryFieldsJson',
        `${code1},Bulk,One,${branchAUsId},FULL_TIME,2024-03-01,"{""SSN"":""111-11-1111"",""W4"":""on-file""}"`,
        `${code2},Bulk,Two,${branchAUsId},FULL_TIME,2024-03-02,"{}"`,
      ].join('\n');

      const submitRes = await post('/employees/import', tokenHrA, { csvContent }).expect(201);
      expect(submitRes.body.totalRows).toBe(2);
      const jobId = submitRes.body.id;

      const finalJob = await waitFor(async () => {
        const res = await get(`/employees/import-jobs/${jobId}`, tokenHrA).expect(200);
        return res.body.status === 'COMPLETED_WITH_ERRORS' || res.body.status === 'COMPLETED' ? res.body : null;
      });

      expect(finalJob.status).toBe('COMPLETED_WITH_ERRORS');
      expect(finalJob.successCount).toBe(1);
      expect(finalJob.errorCount).toBe(1);
      expect(finalJob.errors).toHaveLength(1);
      expect(finalJob.errors[0].row).toBe(3);

      const listRes = await get(`/employees?search=${code1}`, tokenHrA).expect(200);
      expect(listRes.body.data.some((e: { employeeCode: string }) => e.employeeCode === code1)).toBe(true);
    }, 20000);
  });

  describe('documents — stored in and retrieved from MinIO/S3', () => {
    it('uploads a document, lists it, and downloads the exact same bytes back', async () => {
      const createRes = await post('/employees', tokenHrA, usEmployeePayload({ employeeCode: `DOC-${++usCounter}` })).expect(
        201,
      );
      const employeeId = createRes.body.id;
      const fileContents = Buffer.from('this is a test id-proof document');

      const uploadRes = await request(app.getHttpServer())
        .post(`/employees/${employeeId}/documents`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .field('documentType', 'ID_PROOF')
        .attach('file', fileContents, 'passport.txt')
        .expect(201);
      expect(uploadRes.body.fileName).toBe('passport.txt');
      expect(uploadRes.body.sizeBytes).toBe(fileContents.byteLength);

      const listRes = await get(`/employees/${employeeId}/documents`, tokenHrA).expect(200);
      expect(listRes.body).toHaveLength(1);

      const downloadRes = await request(app.getHttpServer())
        .get(`/employees/${employeeId}/documents/${uploadRes.body.id}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((downloadRes.body as Buffer).equals(fileContents)).toBe(true);
    });
  });

  describe('cross-tenant isolation (Row-Level Security)', () => {
    it("tenant B cannot read tenant A's employee by id, and lists none of tenant A's employees", async () => {
      const createRes = await post('/employees', tokenHrA, usEmployeePayload({ employeeCode: `RLS-${++usCounter}` })).expect(
        201,
      );

      await get(`/employees/${createRes.body.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);

      const listRes = await get('/employees', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listRes.body.data.some((e: { id: string }) => e.id === createRes.body.id)).toBe(false);
    });
  });
});
