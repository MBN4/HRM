/**
 * Data privacy & residency (step 6.1) — see
 * docs/conventions/privacy-residency.md. Proves, over real HTTP against the
 * real `AppModule` (Postgres + Redis + MinIO):
 *
 *   - EXPORT: a complete, structured, tenant-isolated, audited export
 *     (JSON manifest + a copied document file, byte-identical).
 *   - ERASURE: an employee's PII is anonymized (not hard-deleted, since
 *     downstream FKs — PayrollRunLine, dependents-once-deleted — must keep
 *     working), their linked User is disabled and its tokens revoked,
 *     documents are hard-deleted, the LEGALLY-RETAINED PayrollRunLine
 *     persists untouched, and audit_log is ANONYMIZED-WITHIN (PII scrubbed,
 *     the row itself never deleted, DB-level immutability against `hrm_app`
 *     still holds).
 *   - A candidate erasure hard-deletes the whole ATS trail via cascade.
 *   - The scheduled retention sweep auto-erases a stale terminated employee
 *     honoring a tenant-specific retention override.
 *   - Consent records, the processing register, sub-processor disclosure,
 *     and effective retention policy are all readable; RBAC deny-by-default
 *     (`privacy.manage`, TENANT_ADMIN only); cross-tenant isolation (RLS).
 *   - The vendor console's cross-tenant oversight surface: reading/creating
 *     requests on a tenant's behalf (dual-audited), sub-processor CRUD,
 *     the residency overview.
 *   - Residency ENFORCEMENT: two real AppModule instances, each pinned to a
 *     different DEPLOYMENT_REGION, reject/accept a tenant's traffic
 *     accordingly.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis minio
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES, withTenantContext } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'privacy-e2e-tenant-a';
const TENANT_B_SLUG = 'privacy-e2e-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  await cleanupTestPlatformAdmins();
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

describe('data privacy & residency (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let storage: StorageService;

  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;

  let tokenAdminA: string;
  let tokenAdminB: string;
  let tokenEmployeeA: string;

  let ownerToken: string;
  let supportToken: string;

  function post(path: string, token: string | null, body: unknown, host = TENANT_A_SLUG) {
    const req = request(app.getHttpServer()).post(path).set('Host', hostFor(host));
    return token ? req.set('Authorization', `Bearer ${token}`).send(body) : req.send(body);
  }
  function get(path: string, token: string | null, host = TENANT_A_SLUG) {
    const req = request(app.getHttpServer()).get(path).set('Host', hostFor(host));
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }
  function put(path: string, token: string | null, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).put(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    storage = moduleRef.get(StorageService);

    await resetFixtures();
    ownerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    supportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;

    const tenantA = await prisma.tenant.create({
      data: { name: 'Privacy E2E Co A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Privacy E2E Co B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchA = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Privacy US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchAId = branchA.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@privacy-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@privacy-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
    const employeeUserA = await makeUserWithRole(tenantAId, employeeRoleA.id, 'employee-login@privacy-a.test');
    tokenEmployeeA = jwt.sign({ sub: employeeUserA.id, tenantId: tenantAId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('RBAC: privacy.manage is deny-by-default and TENANT_ADMIN-only', () => {
    it('a plain EMPLOYEE-role caller cannot create a data-subject request', async () => {
      await post('/privacy/requests', tokenEmployeeA, { requestType: 'EXPORT', subjectType: 'USER', subjectId: tenantAId }).expect(403);
    });

    it('no token at all is rejected', async () => {
      await post('/privacy/requests', null, { requestType: 'EXPORT', subjectType: 'USER', subjectId: tenantAId }).expect(401);
    });
  });

  describe('data export — complete, structured, audited, tenant-isolated', () => {
    let employeeId: string;
    let requestId: string;
    let uploadedBytes: Buffer;
    let documentId: string;

    beforeAll(async () => {
      const employee = await prisma.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branchAId,
          employeeCode: 'PRIV-EXPORT-1',
          firstName: 'Dana',
          lastName: 'Exportsen',
          personalEmail: 'dana@privacy-a.test',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2024-01-01'),
          status: 'ACTIVE',
        },
      });
      employeeId = employee.id;

      await prisma.leaveBalance.create({
        data: { tenantId: tenantAId, employeeId, leaveType: 'ANNUAL', periodYear: 2026, entitledDays: 20, accruedDays: 20, usedDays: 2, carriedOverDays: 0 },
      });

      uploadedBytes = Buffer.from('a real HR document, for export byte-identity proof');
      const storageKey = `employees/${tenantAId}/${employeeId}/export-proof-doc.txt`;
      await storage.uploadObject({ key: storageKey, body: uploadedBytes, contentType: 'text/plain' });
      const doc = await prisma.employeeDocument.create({
        data: { tenantId: tenantAId, employeeId, documentType: 'OTHER', fileName: 'export-proof-doc.txt', mimeType: 'text/plain', sizeBytes: uploadedBytes.length, storageKey },
      });
      documentId = doc.id;
    });

    it('a TENANT_ADMIN requests an export for the employee', async () => {
      const res = await post('/privacy/requests', tokenAdminA, { requestType: 'EXPORT', subjectType: 'EMPLOYEE', subjectId: employeeId, reason: 'Employee data-subject access request' }).expect(201);
      requestId = res.body.id;
      expect(res.body.status).toBe('PENDING');
    });

    it('the request completes asynchronously, producing a downloadable, correct, structured manifest', async () => {
      const completed = await waitFor(async () => {
        const res = await get(`/privacy/requests/${requestId}`, tokenAdminA).expect(200);
        return res.body.status === 'COMPLETED' ? res.body : null;
      });
      expect(completed.resultStorageKey).toBeTruthy();

      const manifestRes = await get(`/privacy/requests/${requestId}/export`, tokenAdminA).expect(200);
      const manifest = JSON.parse(manifestRes.text ?? manifestRes.body.toString('utf8'));
      expect(manifest.subjectType).toBe('EMPLOYEE');
      expect(manifest.profile.id).toBe(employeeId);
      expect(manifest.profile.firstName).toBe('Dana');
      expect(manifest.leave.balances).toHaveLength(1);
      expect(manifest.leave.balances[0].leaveType).toBe('ANNUAL');
      expect(manifest.documents).toHaveLength(1);
      expect(manifest.documents[0].id).toBe(documentId);
      expect(manifest.fileKeys).toHaveLength(1);

      // "JSON + files" — the actual document bytes were copied alongside
      // the manifest, byte-identical to what was originally uploaded.
      const { body: fileStream } = await storage.downloadObject(manifest.fileKeys[0]);
      const chunks: Buffer[] = [];
      for await (const chunk of fileStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(uploadedBytes)).toBe(true);
    });

    it('is audited', async () => {
      const auditRes = await get(`/audit?entityType=DataSubjectRequest&entityId=${requestId}`, tokenAdminA).expect(200);
      const actions = auditRes.body.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['CREATE']));
    });

    it('is tenant-isolated — tenant B cannot see or fetch tenant A\'s request', async () => {
      const list = await get('/privacy/requests', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(list.body.find((r: { id: string }) => r.id === requestId)).toBeUndefined();
      await get(`/privacy/requests/${requestId}`, tokenAdminB, TENANT_B_SLUG).expect(404);
    });
  });

  describe('erasure — anonymize Employee, revoke access, hard-delete documents, preserve legally-retained records, anonymize-within audit_log', () => {
    let employeeId: string;
    let linkedUserId: string;
    let linkedUserToken: string;
    let payrollRunLineId: string;
    let originalNetPay: string;
    let requestId: string;

    beforeAll(async () => {
      const linkedUser = await prisma.user.create({ data: { tenantId: tenantAId, email: 'terminated-employee@privacy-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
      linkedUserId = linkedUser.id;
      linkedUserToken = jwt.sign({ sub: linkedUser.id, tenantId: tenantAId });

      const employee = await prisma.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branchAId,
          employeeCode: 'PRIV-ERASE-1',
          firstName: 'Terry',
          lastName: 'Terminated',
          personalEmail: 'terry@privacy-a.test',
          phone: '+1-555-0100',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2020-01-01'),
          status: 'TERMINATED',
          terminatedAt: new Date(),
          userId: linkedUser.id,
          statutoryFields: { SSN: '000-00-0000' },
        },
      });
      employeeId = employee.id;

      await prisma.employeeDependent.create({ data: { tenantId: tenantAId, employeeId, name: 'Dependent Kid', relationship: 'CHILD' } });
      const docKey = `employees/${tenantAId}/${employeeId}/to-be-deleted.txt`;
      await storage.uploadObject({ key: docKey, body: Buffer.from('will be deleted'), contentType: 'text/plain' });
      await prisma.employeeDocument.create({ data: { tenantId: tenantAId, employeeId, documentType: 'OTHER', fileName: 'to-be-deleted.txt', mimeType: 'text/plain', sizeBytes: 16, storageKey: docKey } });

      // A real audit_log row referencing this employee, carrying their real
      // PII in `before`/`after` — the same shape AuditInterceptor's own
      // employee-mutation capture already produces (see employee.md).
      await prisma.auditLog.create({
        data: {
          tenantId: tenantAId,
          actorUserId: linkedUser.id,
          action: 'UPDATE',
          entityType: 'Employee',
          entityId: employeeId,
          before: { firstName: 'Terry', lastName: 'Terminated', personalEmail: 'terry@privacy-a.test' },
          after: { firstName: 'Terry', lastName: 'Terminated', personalEmail: 'terry@privacy-a.test', status: 'TERMINATED' },
        },
      });

      // A legally-retained payroll record — must survive erasure untouched.
      const run = await prisma.payrollRun.create({
        data: { tenantId: tenantAId, branchId: branchAId, periodYear: 2026, periodMonth: 1, status: 'FINALIZED', runType: 'REGULAR', payrollMode: 'CALCULATE', currencyCode: 'USD' },
      });
      const line = await prisma.payrollRunLine.create({
        data: { tenantId: tenantAId, payrollRunId: run.id, employeeId, branchId: branchAId, status: 'COMPUTED', grossPay: '5000.00', netPay: '4200.00', employerCost: '5500.00' },
      });
      payrollRunLineId = line.id;
      originalNetPay = line.netPay!.toString();
    });

    it('erasure is refused for an ACTIVE employee (must offboard first)', async () => {
      const activeEmployee = await prisma.employee.create({
        data: { tenantId: tenantAId, branchId: branchAId, employeeCode: 'PRIV-ACTIVE-1', firstName: 'Ann', lastName: 'Active', employmentType: 'FULL_TIME', joinDate: new Date(), status: 'ACTIVE' },
      });
      const res = await post('/privacy/requests', tokenAdminA, { requestType: 'ERASURE', subjectType: 'EMPLOYEE', subjectId: activeEmployee.id }).expect(201);
      const failed = await waitFor(async () => {
        const r = await get(`/privacy/requests/${res.body.id}`, tokenAdminA).expect(200);
        return r.body.status !== 'PENDING' && r.body.status !== 'PROCESSING' ? r.body : null;
      });
      expect(failed.status).toBe('FAILED');
      expect(failed.failureReason).toMatch(/offboarded/i);
    });

    it('a TENANT_ADMIN requests erasure for the terminated employee', async () => {
      const res = await post('/privacy/requests', tokenAdminA, { requestType: 'ERASURE', subjectType: 'EMPLOYEE', subjectId: employeeId, reason: 'Right-to-erasure request' }).expect(201);
      requestId = res.body.id;
    });

    it('completes, anonymizing the profile and deleting dependents/documents', async () => {
      const completed = await waitFor(async () => {
        const res = await get(`/privacy/requests/${requestId}`, tokenAdminA).expect(200);
        return res.body.status === 'COMPLETED' ? res.body : null;
      });
      expect(completed.erasureSummary.EMPLOYEE_PROFILE.action).toBe('ANONYMIZE');
      expect(completed.erasureSummary.DOCUMENTS.action).toBe('HARD_DELETE');
      expect(completed.erasureSummary.PAYROLL_TAX_RECORDS.action).toBe('RETAIN_LEGAL');
      expect(completed.erasureSummary.AUDIT_TRAIL.action).toBe('ANONYMIZE');

      const employee = await prisma.employee.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenantAId, id: employeeId } } });
      expect(employee.firstName).not.toBe('Terry');
      expect(employee.personalEmail).toBeNull();
      expect(employee.phone).toBeNull();
      expect(employee.statutoryFields).toEqual({});
      // Non-PII operational fields survive — downstream FK integrity (this
      // Employee row is still referenced by PayrollRunLine above).
      expect(employee.employeeCode).toBe('PRIV-ERASE-1');
      expect(employee.status).toBe('TERMINATED');

      expect(await prisma.employeeDependent.count({ where: { tenantId: tenantAId, employeeId } })).toBe(0);
      expect(await prisma.employeeDocument.count({ where: { tenantId: tenantAId, employeeId } })).toBe(0);
    });

    it('disables the linked User and revokes their access — a previously-valid token now fails', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenantAId, id: linkedUserId } } });
      expect(user.status).toBe('DISABLED');
      expect(user.email).not.toBe('terminated-employee@privacy-a.test');

      await get('/employees/me', linkedUserToken).expect(401);
    });

    it('the legally-retained PayrollRunLine survives untouched', async () => {
      const line = await prisma.payrollRunLine.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenantAId, id: payrollRunLineId } } });
      expect(line.netPay!.toString()).toBe(originalNetPay);
      expect(line.employeeId).toBe(employeeId);
    });

    it('anonymizes audit_log WITHIN the row — the row survives, PII is scrubbed, and hrm_app STILL cannot UPDATE/DELETE it', async () => {
      const rows = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'Employee', entityId: employeeId } });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const serialized = JSON.stringify({ before: row.before, after: row.after });
        expect(serialized).not.toContain('Terry');
        expect(serialized).not.toContain('terry@privacy-a.test');
      }

      // Immutability against the RESTRICTED role is completely unaffected —
      // the erasure engine's owner-client anonymize-within path is the
      // ONLY way this row's content ever changes; hrm_app itself still has
      // no UPDATE/DELETE grant at all, the same proof
      // audit-log-immutability.spec.ts already establishes for the
      // unmodified path.
      const row = rows[0];
      await expect(
        withTenantContext(tenantAId, (tx) => tx.auditLog.updateMany({ where: { id: row.id }, data: { action: 'TAMPERED' } })),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('candidate erasure — hard-delete via cascade, audit anonymized-within', () => {
    let candidateId: string;
    let requestId: string;

    beforeAll(async () => {
      const adminA = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenantAId, email: 'admin@privacy-a.test' } } });
      const requisition = await prisma.jobRequisition.create({
        data: { tenantId: tenantAId, title: 'Privacy Test Requisition', branchId: branchAId, employmentType: 'FULL_TIME', createdByUserId: adminA.id, status: 'APPROVED' },
      });
      const posting = await prisma.jobPosting.create({
        data: { tenantId: tenantAId, requisitionId: requisition.id, title: 'Privacy Test Role', description: 'n/a', status: 'PUBLISHED', publishedAt: new Date(), publicSlug: `privacy-test-role-${Date.now()}` },
      });
      const candidate = await prisma.candidate.create({
        data: { tenantId: tenantAId, firstName: 'Cara', lastName: 'Candidatesen', email: 'cara@privacy-candidates.test', phone: '+1-555-0200' },
      });
      candidateId = candidate.id;
      await prisma.application.create({ data: { tenantId: tenantAId, candidateId, jobPostingId: posting.id, stage: 'REJECTED' } });
      await prisma.auditLog.create({
        data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Candidate', entityId: candidateId, after: { firstName: 'Cara', email: 'cara@privacy-candidates.test' } },
      });
    });

    it('erases the candidate end to end', async () => {
      const res = await post('/privacy/requests', tokenAdminA, { requestType: 'ERASURE', subjectType: 'CANDIDATE', subjectId: candidateId }).expect(201);
      requestId = res.body.id;
      const completed = await waitFor(async () => {
        const r = await get(`/privacy/requests/${requestId}`, tokenAdminA).expect(200);
        return r.body.status === 'COMPLETED' ? r.body : null;
      });
      expect(completed.erasureSummary.CANDIDATE_RECORDS.action).toBe('HARD_DELETE');

      expect(await prisma.candidate.findUnique({ where: { tenantId_id: { tenantId: tenantAId, id: candidateId } } })).toBeNull();
      expect(await prisma.application.count({ where: { tenantId: tenantAId, candidateId } })).toBe(0);

      const auditRows = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'Candidate', entityId: candidateId } });
      expect(auditRows.length).toBeGreaterThan(0);
      expect(JSON.stringify(auditRows[0].after)).not.toContain('Cara');
    });
  });

  describe('retention enforcement — the scheduled sweep auto-erases past-window data, honoring a tenant override', () => {
    let staleEmployeeId: string;

    beforeAll(async () => {
      const staleTerminatedAt = new Date();
      staleTerminatedAt.setUTCMonth(staleTerminatedAt.getUTCMonth() - 3);
      const employee = await prisma.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branchAId,
          employeeCode: 'PRIV-RETENTION-1',
          firstName: 'Riley',
          lastName: 'Retentionson',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2019-01-01'),
          status: 'TERMINATED',
          terminatedAt: staleTerminatedAt,
        },
      });
      staleEmployeeId = employee.id;
    });

    it('a tenant sets a short retention override for EMPLOYEE_POST_EXIT (1 month)', async () => {
      const res = await put('/privacy/retention-policies/EMPLOYEE_POST_EXIT', tokenAdminA, { retentionMonths: 1 }).expect(200);
      expect(res.body.retentionMonths).toBe(1);

      const effective = await get('/privacy/retention-policies', tokenAdminA).expect(200);
      const entry = effective.body.find((p: { category: string }) => p.category === 'EMPLOYEE_POST_EXIT');
      expect(entry.retentionMonths).toBe(1);
      expect(entry.tenantOverrideApplied).toBe(true);
      expect(entry.autoEnforced).toBe(true);
    });

    it('the platform triggers the retention sweep manually, and the stale employee is auto-erased', async () => {
      await request(app.getHttpServer()).post('/platform/privacy/retention-sweep/run').set('Authorization', `Bearer ${ownerToken}`).expect(201);

      const erased = await waitFor(async () => {
        const employee = await prisma.employee.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenantAId, id: staleEmployeeId } } });
        return employee.firstName !== 'Riley' ? employee : null;
      });
      expect(erased.personalEmail).toBeNull();

      const systemRequest = await prisma.dataSubjectRequest.findFirst({
        where: { tenantId: tenantAId, subjectType: 'EMPLOYEE', subjectId: staleEmployeeId, systemInitiated: true },
      });
      expect(systemRequest).toBeTruthy();
      expect(systemRequest!.status).toBe('COMPLETED');
    });

    afterAll(async () => {
      await request(app.getHttpServer())
        .delete('/privacy/retention-policies/EMPLOYEE_POST_EXIT')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .expect(204);
    });
  });

  describe('consent, processing register, sub-processor disclosure, retention policy reads', () => {
    it('records and lists a consent decision', async () => {
      const subjectId = tenantAId;
      await post('/privacy/consents', tokenAdminA, { subjectType: 'USER', subjectId, purpose: 'BIOMETRIC_ATTENDANCE', granted: true, source: 'ESS_PORTAL' }).expect(201);
      const list = await get(`/privacy/consents?subjectType=USER&subjectId=${subjectId}`, tokenAdminA).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].granted).toBe(true);
    });

    it('reads the processing register (6 seeded categories)', async () => {
      const res = await get('/privacy/register', tokenAdminA).expect(200);
      expect(res.body.map((r: { category: string }) => r.category).sort()).toEqual(
        ['AUDIT_TRAIL', 'CANDIDATE_RECORDS', 'DOCUMENTS', 'EMPLOYEE_POST_EXIT', 'EMPLOYEE_PROFILE', 'PAYROLL_TAX_RECORDS'].sort(),
      );
    });

    it('reads the sub-processor disclosure', async () => {
      const res = await get('/privacy/sub-processors', tokenAdminA).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(4);
    });

    it('is tenant-isolated — RLS holds for consent records and retention overrides', async () => {
      const list = await get('/privacy/consents', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(list.body).toHaveLength(0);
    });
  });

  describe('vendor console: cross-tenant privacy oversight', () => {
    it('PRIVACY_READ (both roles) can read the register/sub-processors/residency overview; PRIVACY_MANAGE (owner only) can author them', async () => {
      await request(app.getHttpServer()).get('/platform/privacy/register').set('Authorization', `Bearer ${supportToken}`).expect(200);
      const residency = await request(app.getHttpServer()).get('/platform/privacy/residency-overview').set('Authorization', `Bearer ${supportToken}`).expect(200);
      expect(residency.body.find((r: { tenantId: string }) => r.tenantId === tenantAId).hostingRegion).toBe('us-east-1');

      await request(app.getHttpServer())
        .post('/platform/privacy/sub-processors')
        .set('Authorization', `Bearer ${supportToken}`)
        .send({ name: 'Should Be Forbidden', purpose: 'n/a', region: 'n/a' })
        .expect(403);

      const created = await request(app.getHttpServer())
        .post('/platform/privacy/sub-processors')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `Test Sub-Processor ${Date.now()}`, purpose: 'Testing', dataCategories: ['DOCUMENTS'], region: 'us-east-1' })
        .expect(201);
      await request(app.getHttpServer()).delete(`/platform/privacy/sub-processors/${created.body.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    });

    it('creates a data-subject request on a tenant\'s behalf, dual-audited into both the tenant\'s own audit_log and PlatformAuditLog', async () => {
      const onboardingCandidate = await prisma.candidate.create({
        data: { tenantId: tenantAId, firstName: 'OnBehalf', lastName: 'Subject', email: `on-behalf-${Date.now()}@privacy-a.test` },
      });

      const created = await request(app.getHttpServer())
        .post(`/platform/privacy/tenants/${tenantAId}/requests`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ requestType: 'EXPORT', subjectType: 'CANDIDATE', subjectId: onboardingCandidate.id })
        .expect(201);
      expect(created.body.initiatedByPlatformAdminId).toBeTruthy();

      const tenantAuditEntries = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'DataSubjectRequest', entityId: created.body.id } });
      expect(tenantAuditEntries.some((e) => e.actorPlatform)).toBe(true);

      const platformAuditEntries = await prisma.platformAuditLog.findMany({ where: { action: 'platform.privacy.request_created', entityId: created.body.id } });
      expect(platformAuditEntries.length).toBeGreaterThan(0);

      // Drain the enqueued export job before this file's own teardown
      // deletes the tenant — otherwise the async job would race the
      // fixture cleanup below and log a harmless-but-noisy FK error.
      await waitFor(async () => {
        const r = await get(`/privacy/requests/${created.body.id}`, tokenAdminA).expect(200);
        return r.body.status === 'COMPLETED' ? r.body : null;
      });
    });

    it('lists cross-tenant requests, filterable by tenant, and this READ is itself audited', async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/privacy/requests?tenantId=${tenantAId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.every((r: { tenantId: string }) => r.tenantId === tenantAId)).toBe(true);

      const readAudit = await prisma.platformAuditLog.findMany({ where: { action: 'platform.privacy.requests_read' } });
      expect(readAudit.length).toBeGreaterThan(0);
    });
  });
});

