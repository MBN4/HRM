/**
 * Table partitioning + archival (step 5.2) — see
 * docs/conventions/partitioning-archival.md. Proves, over real HTTP against
 * the real `AppModule` (Postgres + Redis + MinIO), the app-layer pieces that
 * sit on top of `packages/db`'s native `PARTITION BY RANGE` conversion
 * (proven directly against Postgres by `packages/db/test/partitioning.spec.ts`):
 *
 *   - RBAC: PARTITIONING_READ (both platform roles) vs. PARTITIONING_MANAGE
 *     (PLATFORM_OWNER only).
 *   - The automated partition-creation job/manual trigger: a write to a
 *     FUTURE date — beyond what already existed — lands in the correct
 *     partition once `ensure` has run, never a "no partition found" error.
 *   - Archival: an aged partition is detached/exported/dropped per its
 *     table's retention config, the exported object is downloadable and
 *     decompresses to the exact archived rows, and remaining (non-aged)
 *     data is completely unaffected — still there, still RLS/immutability-
 *     protected.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis minio
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { gunzipSync } from 'node:zlib';
import { appPrisma, prisma, withTenantContext } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const SLUG = 'partitioning-e2e-tenant';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
  await cleanupTestPlatformAdmins();
}

function monthStart(monthsFromNow: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
}

describe('table partitioning + archival (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let ownerToken: string;
  let supportToken: string;
  let tenantId: string;
  let originalAuditConfig: { lookaheadMonths: number; retentionMonths: number; archiveEnabled: boolean };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    ownerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    supportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;

    const tenant = await prisma.tenant.create({
      data: { name: 'Partitioning E2E Co', slug: SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;

    const config = await prisma.partitionedTableConfig.findUniqueOrThrow({ where: { tableName: 'AUDIT_LOG' } });
    originalAuditConfig = { lookaheadMonths: config.lookaheadMonths, retentionMonths: config.retentionMonths, archiveEnabled: config.archiveEnabled };
  });

  afterAll(async () => {
    // Restore the SHARED platform-wide config this suite temporarily
    // changes — it's global, not tenant-scoped, so leaving it mutated
    // would bleed into any other suite run against the same DB.
    await prisma.partitionedTableConfig.update({ where: { tableName: 'AUDIT_LOG' }, data: originalAuditConfig });
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('RBAC', () => {
    it('PARTITIONING_READ: both platform roles can read config/status', async () => {
      await request(app.getHttpServer()).get('/platform/partitioning/config').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      await request(app.getHttpServer()).get('/platform/partitioning/config').set('Authorization', `Bearer ${supportToken}`).expect(200);
      await request(app.getHttpServer()).get('/platform/partitioning/status').set('Authorization', `Bearer ${supportToken}`).expect(200);
    });

    it('PARTITIONING_MANAGE: PLATFORM_SUPPORT is forbidden from mutating config or triggering jobs', async () => {
      await request(app.getHttpServer())
        .put('/platform/partitioning/config/AUDIT_LOG')
        .set('Authorization', `Bearer ${supportToken}`)
        .send({ retentionMonths: 99 })
        .expect(403);
      await request(app.getHttpServer()).post('/platform/partitioning/ensure').set('Authorization', `Bearer ${supportToken}`).expect(403);
      await request(app.getHttpServer()).post('/platform/partitioning/archive').set('Authorization', `Bearer ${supportToken}`).expect(403);
    });

    it('deny-by-default: no token at all is rejected', async () => {
      await request(app.getHttpServer()).get('/platform/partitioning/config').expect(401);
    });
  });

  describe('status + config', () => {
    it('reports partitions for every managed table, and the seeded default config', async () => {
      const status = await request(app.getHttpServer()).get('/platform/partitioning/status').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(Object.keys(status.body).sort()).toEqual(['ATTENDANCE_RECORDS', 'AUDIT_LOG', 'PLATFORM_AUDIT_LOG']);
      expect(Array.isArray(status.body.AUDIT_LOG)).toBe(true);
      expect(status.body.AUDIT_LOG.length).toBeGreaterThan(0);
      expect(status.body.AUDIT_LOG[0]).toMatchObject({ partitionName: expect.any(String), rangeStart: expect.any(String), rangeEnd: expect.any(String) });

      const configs = await request(app.getHttpServer()).get('/platform/partitioning/config').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const byName = Object.fromEntries(configs.body.map((c: { tableName: string }) => [c.tableName, c]));
      expect(byName.ATTENDANCE_RECORDS).toMatchObject({ lookaheadMonths: expect.any(Number), retentionMonths: expect.any(Number), archiveEnabled: true });
    });
  });

  describe('automated partition creation — a write to a future date lands in the right partition', () => {
    it('raising lookaheadMonths and triggering /ensure creates the partition a later write needs', async () => {
      const farFuture = monthStart(11); // well beyond the default 3-month lookahead

      // Before raising the lookahead, a write this far out has no partition.
      await expect(
        prisma.attendanceRecord.count({
          where: { workDate: farFuture },
        }),
      ).resolves.toBeGreaterThanOrEqual(0); // sanity: table itself is queryable regardless

      await request(app.getHttpServer())
        .put('/platform/partitioning/config/ATTENDANCE_RECORDS')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ lookaheadMonths: 12 })
        .expect(200);

      await request(app.getHttpServer()).post('/platform/partitioning/ensure').set('Authorization', `Bearer ${ownerToken}`).expect(201);

      const status = await request(app.getHttpServer()).get('/platform/partitioning/status').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const partitionNames: string[] = status.body.ATTENDANCE_RECORDS.map((p: { partitionName: string }) => p.partitionName);
      const expectedSuffix = `${farFuture.getUTCFullYear()}_${String(farFuture.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(partitionNames.some((name) => name.endsWith(expectedSuffix))).toBe(true);

      // Reset back to the default so this doesn't linger for other suites.
      await request(app.getHttpServer())
        .put('/platform/partitioning/config/ATTENDANCE_RECORDS')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ lookaheadMonths: 3 })
        .expect(200);

      // A REAL write that far out — through the tenant-scoped app role,
      // exactly like a real clock-in would — now succeeds because the
      // partition exists.
      const branch = await prisma.branch.create({ data: { tenantId, name: 'HQ', countryCode: 'US', timezone: 'UTC' } });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          branchId: branch.id,
          employeeCode: 'PART-E2E-1',
          firstName: 'Future',
          lastName: 'Writer',
          employmentType: 'FULL_TIME',
          joinDate: new Date(),
          status: 'ACTIVE',
        },
      });
      const created = await withTenantContext(tenantId, (tx) =>
        tx.attendanceRecord.create({
          data: {
            tenantId,
            employeeId: employee.id,
            branchId: branch.id,
            workDate: farFuture,
            clockInAt: farFuture,
            clockInSource: 'WEB',
          },
        }),
      );
      expect(created.id).toBeTruthy();
    });
  });

  describe('archival — aged partition detaches/exports/drops per retention; remaining data intact + retrievable', () => {
    it('archives an old audit_log partition to storage, lists it, downloads it, and leaves recent data untouched', async () => {
      const oldMonth = monthStart(-40); // ~3.3 years back — nothing else in this suite touches this range
      const suffix = `${oldMonth.getUTCFullYear()}_${String(oldMonth.getUTCMonth() + 1).padStart(2, '0')}`;
      const partitionName = `audit_log_p${suffix}`;

      // This suite may have run before against the same persistent dev DB —
      // `oldMonth` is deterministic for "today", so a PRIOR run may have
      // already archived (and dropped) this exact partition name. Clean up
      // that stale bookkeeping row so this run gets a genuinely fresh
      // partition to archive, the same self-contained-repeatable-run
      // hygiene every other fixture reset in this suite already takes.
      await prisma.archivedPartition.deleteMany({ where: { tableName: 'AUDIT_LOG', partitionName } });

      await prisma.$executeRaw`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', ${oldMonth}::date, ${oldMonth}::date)`;
      const oldRow = await withTenantContext(tenantId, (tx) =>
        tx.auditLog.create({
          data: { tenantId, occurredAt: new Date(oldMonth.getTime() + 1000 * 60 * 60 * 24 * 5), action: 'CREATE', entityType: 'ArchivalFixture', entityId: 'old-row' },
        }),
      );
      const recentRow = await withTenantContext(tenantId, (tx) =>
        tx.auditLog.create({ data: { tenantId, action: 'CREATE', entityType: 'ArchivalFixture', entityId: 'recent-row' } }),
      );

      // Retention short enough that the OLD partition qualifies but nothing
      // recent does (its rangeEnd is only one MONTH wide and ~3+ years back).
      await request(app.getHttpServer())
        .put('/platform/partitioning/config/AUDIT_LOG')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ retentionMonths: 12 })
        .expect(200);

      const sweep = await request(app.getHttpServer()).post('/platform/partitioning/archive').set('Authorization', `Bearer ${ownerToken}`).expect(201);
      const archivedThisTable = sweep.body.filter((r: { tableName: string; partitionName: string }) => r.tableName === 'AUDIT_LOG' && r.partitionName.endsWith(suffix));
      expect(archivedThisTable).toHaveLength(1);

      // Listed via the platform API.
      const archives = await request(app.getHttpServer()).get('/platform/partitioning/archives').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const archiveRow = archives.body.find((a: { partitionName: string }) => a.partitionName === archivedThisTable[0].partitionName);
      expect(archiveRow).toBeTruthy();
      expect(archiveRow.rowCount).toBeGreaterThanOrEqual(1);

      // Downloadable, and decompresses to the ACTUAL archived row.
      const download = await request(app.getHttpServer())
        .get(`/platform/partitioning/archives/${archiveRow.id}/download`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const decompressed = gunzipSync(download.body as Buffer).toString('utf8');
      expect(decompressed).toContain('old-row');
      expect(decompressed).toContain(oldRow.id);

      // The partition itself is really gone from Postgres...
      const partitionExists = await prisma.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${`audit_log_p${suffix}`}) AS exists`;
      expect(partitionExists[0].exists).toBe(false);

      // ...but audit_log itself, RLS, and immutability are all still fully
      // intact for the data that WASN'T archived.
      const stillThere = await withTenantContext(tenantId, (tx) => tx.auditLog.findUnique({ where: { id_occurredAt: { id: recentRow.id, occurredAt: recentRow.occurredAt } } }));
      expect(stillThere?.entityId).toBe('recent-row');
      await expect(
        withTenantContext(tenantId, (tx) => tx.auditLog.updateMany({ where: { id: recentRow.id }, data: { action: 'HACKED' } })),
      ).rejects.toThrow(/permission denied/i);

      // A second archival sweep is a no-op for the same partition (already archived, never re-processed).
      const secondSweep = await request(app.getHttpServer()).post('/platform/partitioning/archive').set('Authorization', `Bearer ${ownerToken}`).expect(201);
      expect(secondSweep.body.some((r: { partitionName: string }) => r.partitionName.endsWith(suffix))).toBe(false);
    });
  });

  describe('tenant retention override — the documented Phase 6.1 seam', () => {
    it('can be set, read back, and removed, dual-audited into both the tenant and platform trails', async () => {
      await request(app.getHttpServer())
        .put(`/platform/partitioning/tenants/${tenantId}/retention-overrides/AUDIT_LOG`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ retentionMonths: 6 })
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`/platform/partitioning/tenants/${tenantId}/retention-overrides`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(list.body).toEqual([expect.objectContaining({ tableName: 'AUDIT_LOG', retentionMonths: 6 })]);

      const tenantAudit = await withTenantContext(tenantId, (tx) => tx.auditLog.findMany({ where: { entityType: 'TenantRetentionOverride' } }));
      expect(tenantAudit.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .delete(`/platform/partitioning/tenants/${tenantId}/retention-overrides/AUDIT_LOG`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);

      const listAfter = await request(app.getHttpServer())
        .get(`/platform/partitioning/tenants/${tenantId}/retention-overrides`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(listAfter.body).toEqual([]);
    });
  });
});
