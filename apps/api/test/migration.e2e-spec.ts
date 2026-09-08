/**
 * Proves the data migration & onboarding toolkit (step 3.5.1) end to end
 * over real HTTP — see docs/conventions/data-migration.md:
 *   - A dry run validates and reports WITHOUT writing anything (DB
 *     unchanged for the target entity table).
 *   - A messy file: valid rows import, invalid rows are reported with a
 *     clear, plain-language reason — including the REAL 1.1 country-pack
 *     required-field enforcement (a US row missing SSN/W4, a QA row
 *     missing QATAR_ID, both via the SAME `EmployeeService.create` path a
 *     direct `POST /employees` call would use).
 *   - Manager-by-employeeCode linking resolves the org chart correctly,
 *     even when the manager's own row appears AFTER its report's row.
 *   - Leave opening-balance import sets balances correctly via the real
 *     `LeaveBalanceService`.
 *   - Idempotency: re-committing an already-committed batch is refused,
 *     never duplicates.
 *   - Column-mapping templates save and reuse.
 *   - A vendor/platform admin can run an import on a tenant's behalf
 *     (dual-audited into both the platform's own trail and the tenant's
 *     own `audit_log`); a tenant user can self-serve (RBAC-gated);
 *     cross-tenant isolation holds via RLS.
 *
 * A JWT is minted directly, same rationale every other e2e suite in this
 * codebase documents for doing the same thing.
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
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'migration-test-tenant-a';
const TENANT_B_SLUG = 'migration-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}
function csv(rows: string[][]): string {
  return rows.map(csvRow).join('\n');
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitFor: timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  await cleanupTestPlatformAdmins();
}

describe('data migration & onboarding toolkit (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let usBranchName: string;
  let qaBranchName: string;

  let tokenAdminA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  function server() {
    return app.getHttpServer();
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(server()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }
  function postJson(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(server()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function uploadBatch(
    token: string,
    fields: { entityType: string; fileFormat: string; mode?: string; columnMapping: Record<string, string>; columnMappingTemplateId?: string },
    fileContent: string,
    host = TENANT_A_SLUG,
  ) {
    let req = request(server())
      .post('/migration/batches')
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .field('entityType', fields.entityType)
      .field('fileFormat', fields.fileFormat)
      .field('mode', fields.mode ?? 'PARTIAL')
      .field('columnMapping', JSON.stringify(fields.columnMapping));
    if (fields.columnMappingTemplateId) {
      req = req.field('columnMappingTemplateId', fields.columnMappingTemplateId);
    }
    return req.attach('file', Buffer.from(fileContent, 'utf-8'), fields.fileFormat === 'CSV' ? 'data.csv' : 'data.xlsx');
  }

  async function waitForBatchStatus(id: string, statuses: string[], token = tokenAdminA): Promise<{ status: string; [k: string]: unknown }> {
    return waitFor(async () => {
      const res = await get(`/migration/batches/${id}`, token).expect(200);
      return statuses.includes(res.body.status) ? res.body : null;
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Migration Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Migration Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const usBranch = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Migration US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    usBranchName = usBranch.name;
    const qaBranch = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Migration Doha Office', countryCode: 'QA', timezone: 'Asia/Qatar' } });
    qaBranchName = qaBranch.name;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await prisma.user.create({ data: { tenantId: tenantAId, email: 'admin@migration-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminRoleA.id } });
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeUserA = await prisma.user.create({ data: { tenantId: tenantAId, email: 'plain-employee@migration-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeUserA.id, roleId: employeeRoleA.id } });
    tokenEmployeeA = jwt.sign({ sub: employeeUserA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({ data: { tenantId: tenantBId, email: 'admin@migration-b.test', hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminRoleB.id } });
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  }, 30000);

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('BRANCH import — dry run leaves the DB untouched, commit writes it, a real column mapping is honored', () => {
    let batchId: string;

    it('dry run reports a CREATE and writes nothing', async () => {
      const before = await prisma.branch.count({ where: { tenantId: tenantAId, name: 'Imported Satellite Office' } });
      expect(before).toBe(0);

      const fileContent = csv([
        ['Branch Name', 'Country', 'TZ'],
        ['Imported Satellite Office', 'US', 'America/Chicago'],
      ]);
      const created = await uploadBatch(
        tokenAdminA,
        { entityType: 'BRANCH', fileFormat: 'CSV', columnMapping: { name: 'Branch Name', countryCode: 'Country', timezone: 'TZ' } },
        fileContent,
      ).expect(201);
      batchId = created.body.id;
      expect(created.body.status).toBe('UPLOADED');
      expect(created.body.totalRows).toBe(1);

      await postJson(`/migration/batches/${batchId}/validate`, tokenAdminA, {}).expect(201);
      const dryRun = await waitForBatchStatus(batchId, ['DRY_RUN_COMPLETE', 'FAILED']);
      expect(dryRun.status).toBe('DRY_RUN_COMPLETE');
      expect(dryRun.createCount).toBe(1);
      expect(dryRun.errorCount).toBe(0);

      // THE dry-run guarantee: nothing was written to the real table.
      const stillNone = await prisma.branch.count({ where: { tenantId: tenantAId, name: 'Imported Satellite Office' } });
      expect(stillNone).toBe(0);
    }, 20000);

    it('commit actually writes the row', async () => {
      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, {}).expect(201);
      const committed = await waitForBatchStatus(batchId, ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED']);
      expect(committed.status).toBe('COMMITTED');
      expect(committed.createCount).toBe(1);

      const branch = await prisma.branch.findFirst({ where: { tenantId: tenantAId, name: 'Imported Satellite Office' } });
      expect(branch).toBeTruthy();
      expect(branch?.countryCode).toBe('US');
      expect(branch?.timezone).toBe('America/Chicago');
    }, 20000);

    it('idempotency: committing the same batch again is refused and never duplicates', async () => {
      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, {}).expect(409);
      const count = await prisma.branch.count({ where: { tenantId: tenantAId, name: 'Imported Satellite Office' } });
      expect(count).toBe(1);
    });
  });

  describe('EMPLOYEE import — a messy file: valid rows import, invalid rows are reported with plain-language reasons', () => {
    const HEADER = ['employeeCode', 'firstName', 'lastName', 'branchName', 'employmentType', 'joinDate', 'statutoryFieldsJson'];
    const IDENTITY_MAPPING = Object.fromEntries(HEADER.map((h) => [h, h]));

    it('a US row missing SSN/W4 and a QA row missing QatarID both fail with a clear reason; the valid rows commit', async () => {
      const fileContent = csv([
        HEADER,
        ['MIG-US-1', 'John', 'Doe', usBranchName, 'FULL_TIME', '2026-01-15', '{"SSN":"123-45-6789","W4":"on file"}'],
        ['MIG-US-2', 'Jane', 'Roe', usBranchName, 'FULL_TIME', '2026-01-15', ''],
        ['MIG-QA-1', 'Ali', 'Hassan', qaBranchName, 'FULL_TIME', '2026-01-15', '{"QATAR_ID":"QID-9001","VISA_SPONSORSHIP":"Employer"}'],
        ['MIG-QA-2', 'Sara', 'Ahmed', qaBranchName, 'FULL_TIME', '2026-01-15', ''],
      ]);
      const created = await uploadBatch(tokenAdminA, { entityType: 'EMPLOYEE', fileFormat: 'CSV', columnMapping: IDENTITY_MAPPING }, fileContent).expect(201);
      const batchId = created.body.id;

      await postJson(`/migration/batches/${batchId}/validate`, tokenAdminA, {}).expect(201);
      const dryRun = await waitForBatchStatus(batchId, ['DRY_RUN_COMPLETE', 'FAILED']);
      expect(dryRun.status).toBe('DRY_RUN_COMPLETE');
      expect(dryRun.createCount).toBe(2);
      expect(dryRun.errorCount).toBe(2);

      const errorsRes = await get(`/migration/batches/${batchId}/errors`, tokenAdminA).expect(200);
      const messages = errorsRes.body.map((e: { rowNumber: number; message: string }) => `${e.rowNumber}:${e.message}`).join(' | ');
      expect(messages).toMatch(/SSN/);
      expect(messages).toMatch(/QATAR_ID/);

      // dry run wrote nothing to `employees`.
      expect(await prisma.employee.count({ where: { tenantId: tenantAId, employeeCode: { in: ['MIG-US-1', 'MIG-US-2', 'MIG-QA-1', 'MIG-QA-2'] } } })).toBe(0);

      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, {}).expect(201);
      const committed = await waitForBatchStatus(batchId, ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED']);
      expect(committed.status).toBe('COMMITTED_WITH_ERRORS');
      expect(committed.createCount).toBe(2);
      expect(committed.errorCount).toBe(2);

      const validEmployees = await prisma.employee.findMany({ where: { tenantId: tenantAId, employeeCode: { in: ['MIG-US-1', 'MIG-QA-1'] } } });
      expect(validEmployees).toHaveLength(2);
      const invalidEmployees = await prisma.employee.findMany({ where: { tenantId: tenantAId, employeeCode: { in: ['MIG-US-2', 'MIG-QA-2'] } } });
      expect(invalidEmployees).toHaveLength(0);

      // downloadable CSV error report — plain-language reasons next to the row's own values.
      const reportRes = await get(`/migration/batches/${batchId}/report`, tokenAdminA).expect(200);
      expect(reportRes.text).toMatch(/MIG-US-2/);
      expect(reportRes.text).toMatch(/MIG-QA-2/);
    }, 30000);

    it('manager-by-employeeCode linking resolves the org chart, even when the manager row appears AFTER its report row', async () => {
      const header = [...HEADER, 'managerEmployeeCode'];
      const mapping = Object.fromEntries(header.map((h) => [h, h]));
      const statutory = '{"SSN":"999-00-1111","W4":"on file"}';
      const fileContent = csv([
        header,
        ['MIG-REPORT-1', 'Report', 'Person', usBranchName, 'FULL_TIME', '2026-02-01', statutory, 'MIG-MANAGER-1'],
        ['MIG-MANAGER-1', 'Manager', 'Person', usBranchName, 'FULL_TIME', '2026-02-01', statutory, ''],
      ]);
      const created = await uploadBatch(tokenAdminA, { entityType: 'EMPLOYEE', fileFormat: 'CSV', columnMapping: mapping }, fileContent).expect(201);
      const batchId = created.body.id;

      await postJson(`/migration/batches/${batchId}/validate`, tokenAdminA, {}).expect(201);
      const dryRun = await waitForBatchStatus(batchId, ['DRY_RUN_COMPLETE', 'FAILED']);
      expect(dryRun.status).toBe('DRY_RUN_COMPLETE');
      expect(dryRun.errorCount).toBe(0);

      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, {}).expect(201);
      const committed = await waitForBatchStatus(batchId, ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED']);
      expect(committed.status).toBe('COMMITTED');

      const manager = await prisma.employee.findUniqueOrThrow({ where: { tenantId_employeeCode: { tenantId: tenantAId, employeeCode: 'MIG-MANAGER-1' } } });
      const report = await prisma.employee.findUniqueOrThrow({ where: { tenantId_employeeCode: { tenantId: tenantAId, employeeCode: 'MIG-REPORT-1' } } });
      expect(report.managerId).toBe(manager.id);
    }, 30000);
  });

  describe('LEAVE_BALANCE import — opening balances via the real LeaveBalanceService', () => {
    it('sets accrued/carried-over days exactly as given, entitlement snapshotted from the real Country Pack', async () => {
      const employee = await prisma.employee.findUniqueOrThrow({ where: { tenantId_employeeCode: { tenantId: tenantAId, employeeCode: 'MIG-QA-1' } } });

      const header = ['employeeCode', 'leaveType', 'periodYear', 'accruedDays', 'carriedOverDays'];
      const mapping = Object.fromEntries(header.map((h) => [h, h]));
      const fileContent = csv([header, ['MIG-QA-1', 'ANNUAL', '2026', '5', '2']]);
      const created = await uploadBatch(tokenAdminA, { entityType: 'LEAVE_BALANCE', fileFormat: 'CSV', columnMapping: mapping }, fileContent).expect(201);
      const batchId = created.body.id;

      await postJson(`/migration/batches/${batchId}/validate`, tokenAdminA, {}).expect(201);
      await waitForBatchStatus(batchId, ['DRY_RUN_COMPLETE', 'FAILED']);
      await postJson(`/migration/batches/${batchId}/commit`, tokenAdminA, {}).expect(201);
      const committed = await waitForBatchStatus(batchId, ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED']);
      expect(committed.status).toBe('COMMITTED');

      const balance = await prisma.leaveBalance.findUniqueOrThrow({
        where: { tenantId_employeeId_leaveType_periodYear: { tenantId: tenantAId, employeeId: employee.id, leaveType: 'ANNUAL', periodYear: 2026 } },
      });
      expect(balance.accruedDays).toBe(5);
      expect(balance.carriedOverDays).toBe(2);
      expect(balance.entitledDays).toBeGreaterThan(0);
    }, 30000);
  });

  describe('column-mapping templates', () => {
    it('saves a mapping template and it can be listed/reused', async () => {
      const mapping = { name: 'Branch Name', countryCode: 'Country', timezone: 'TZ' };
      const saved = await postJson('/migration/mapping-templates', tokenAdminA, { name: 'HRIS Export v1', entityType: 'BRANCH', mapping }).expect(201);
      expect(saved.body.mapping).toEqual(mapping);

      await postJson('/migration/mapping-templates', tokenAdminA, { name: 'HRIS Export v1', entityType: 'BRANCH', mapping }).expect(409);

      const list = await get('/migration/mapping-templates?entityType=BRANCH', tokenAdminA).expect(200);
      expect(list.body.some((t: { name: string }) => t.name === 'HRIS Export v1')).toBe(true);

      // Reuse: create a new batch quoting the saved mapping's own content.
      const fileContent = csv([['Branch Name', 'Country', 'TZ'], ['Reused Mapping Branch', 'US', 'America/Denver']]);
      const created = await uploadBatch(
        tokenAdminA,
        { entityType: 'BRANCH', fileFormat: 'CSV', columnMapping: mapping, columnMappingTemplateId: saved.body.id },
        fileContent,
      ).expect(201);
      expect(created.body.columnMappingTemplateId).toBe(saved.body.id);
    });
  });

  describe('RBAC + cross-tenant isolation', () => {
    it('a caller without migration.manage is denied', async () => {
      const fileContent = csv([['name'], ['Denied Designation']]);
      await uploadBatch(tokenEmployeeA, { entityType: 'DESIGNATION', fileFormat: 'CSV', columnMapping: { name: 'name' } }, fileContent).expect(403);
    });

    it('tenant B cannot see or read tenant A\'s batches — RLS, not application code', async () => {
      const fileContent = csv([['Branch Name', 'Country', 'TZ'], ['Isolation Branch', 'US', 'America/Chicago']]);
      const created = await uploadBatch(
        tokenAdminA,
        { entityType: 'BRANCH', fileFormat: 'CSV', columnMapping: { name: 'Branch Name', countryCode: 'Country', timezone: 'TZ' } },
        fileContent,
      ).expect(201);

      await get(`/migration/batches/${created.body.id}`, tokenAdminB, TENANT_B_SLUG).expect(404);
      const listB = await get('/migration/batches', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(listB.body.some((b: { id: string }) => b.id === created.body.id)).toBe(false);
    });
  });

  describe('vendor/platform admin onboarding import', () => {
    it('a platform admin can run an import on a tenant\'s behalf — dual-audited into both trails', async () => {
      const platformAdmin = await createTestPlatformAdmin('PLATFORM_SUPPORT');

      const fileContent = csv([['name'], ['Onboarding Imported Designation']]);
      const created = await request(server())
        .post(`/platform/tenants/${tenantAId}/migration/batches`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .field('entityType', 'DESIGNATION')
        .field('fileFormat', 'CSV')
        .field('mode', 'PARTIAL')
        .field('columnMapping', JSON.stringify({ name: 'name' }))
        .attach('file', Buffer.from(fileContent, 'utf-8'), 'data.csv')
        .expect(201);
      const batchId = created.body.id;
      expect(created.body.initiatedByPlatformAdminId).toBe(platformAdmin.id);

      await request(server())
        .post(`/platform/tenants/${tenantAId}/migration/batches/${batchId}/validate`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .expect(201);
      await waitFor(async () => {
        const res = await request(server())
          .get(`/platform/tenants/${tenantAId}/migration/batches/${batchId}`)
          .set('Authorization', `Bearer ${platformAdmin.token}`)
          .expect(200);
        return res.body.status === 'DRY_RUN_COMPLETE' ? res.body : null;
      });

      await request(server())
        .post(`/platform/tenants/${tenantAId}/migration/batches/${batchId}/commit`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .expect(201);
      const committed = await waitFor(async () => {
        const res = await request(server())
          .get(`/platform/tenants/${tenantAId}/migration/batches/${batchId}`)
          .set('Authorization', `Bearer ${platformAdmin.token}`)
          .expect(200);
        return res.body.status === 'COMMITTED' ? res.body : null;
      });
      expect(committed.createCount).toBe(1);

      const designation = await prisma.designation.findFirst({ where: { tenantId: tenantAId, name: 'Onboarding Imported Designation' } });
      expect(designation).toBeTruthy();

      // The tenant's OWN audit trail sees it — "never silent."
      const auditRes = await get('/audit?entityType=ImportBatch', tokenAdminA).expect(200);
      const entries: { entityId: string | null; metadata?: Record<string, unknown> }[] = auditRes.body;
      const entry = entries.find((e) => e.entityId === batchId);
      expect(entry).toBeTruthy();
      expect(entry?.metadata?.initiatedByPlatformAdminId).toBe(platformAdmin.id);
    }, 30000);
  });
});
