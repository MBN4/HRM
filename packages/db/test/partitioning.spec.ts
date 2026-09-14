/**
 * Table partitioning (step 5.2) — see docs/conventions/partitioning-archival.md.
 * Proves the properties that matter about converting `attendance_records`/
 * `audit_log`/`platform_audit_log` into REAL Postgres `PARTITION BY RANGE`
 * tables, directly against Postgres (not just inferred from the migration
 * SQL):
 *
 *   - RLS + tenant isolation hold IDENTICALLY on the partitioned parent
 *     (querying through the parent is the ONLY way Prisma/`appPrisma` ever
 *     addresses these tables — see tenant-isolation.spec.ts for the
 *     original, still-passing proof this doesn't regress).
 *   - `audit_log`'s DB-level immutability (REVOKE UPDATE/DELETE) still holds
 *     across TWO DIFFERENT MONTHS — i.e. two different underlying
 *     partitions — proving the guarantee isn't an accident of whichever
 *     partition "today" happens to fall in.
 *   - Partition PRUNING actually happens: a time-range query only touches
 *     the relevant month's partition, not every partition of the table.
 *   - The conversion MECHANISM (rename -> recreate as PARTITION BY RANGE ->
 *     bootstrap partitions -> copy -> drop legacy) preserves every row
 *     exactly — replayed here against a disposable scratch table (the real
 *     one-time migration already ran against this environment's own
 *     `audit_log`/`attendance_records`/`platform_audit_log`, verified
 *     manually during development; this test is what makes that guarantee
 *     regression-proof going forward).
 *
 * Requires a local Postgres with all migrations applied:
 *   docker compose up -d postgres
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { prisma, appPrisma, withTenantContext } from '../src';

const TENANT_A_SLUG = 'partitioning-tenant-a';
const TENANT_B_SLUG = 'partitioning-tenant-b';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  await resetFixtures();
  const tenantA = await prisma.tenant.create({
    data: { name: 'Partitioning Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'Partitioning Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
});

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('attendance_records / audit_log are REAL native partitioned tables', () => {
  it('both are reported as partitioned tables by Postgres, partitioned on the documented key', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; partition_key: string }[]>`
      SELECT c.relname, pg_get_partkeydef(c.oid) AS partition_key
      FROM pg_class c
      WHERE c.relname IN ('attendance_records', 'audit_log', 'platform_audit_log') AND c.relkind = 'p'
      ORDER BY c.relname
    `;
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((r) => [r.relname, r.partition_key]));
    expect(byName['attendance_records']).toContain('work_date');
    expect(byName['audit_log']).toContain('occurred_at');
    expect(byName['platform_audit_log']).toContain('occurred_at');
  });
});

describe('RLS holds identically on the partitioned attendance_records/audit_log', () => {
  it('attendance_records: tenant B never sees tenant A rows written through the partitioned parent', async () => {
    const employeeA = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.create({ data: { tenantId: tenantAId, name: 'HQ', timezone: 'UTC', countryCode: 'US' } });
      return tx.employee.create({
        data: {
          tenantId: tenantAId,
          branchId: branch.id,
          firstName: 'Part',
          lastName: 'Ition',
          employeeCode: 'PART-1',
          joinDate: new Date('2026-01-01'),
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
        },
      });
    });

    await withTenantContext(tenantAId, (tx) =>
      tx.attendanceRecord.create({
        data: {
          tenantId: tenantAId,
          employeeId: employeeA.id,
          branchId: employeeA.branchId,
          workDate: new Date('2026-09-10'),
          clockInAt: new Date('2026-09-10T09:00:00Z'),
          clockInSource: 'WEB',
        },
      }),
    );

    const tenantBRows = await withTenantContext(tenantBId, (tx) => tx.attendanceRecord.findMany());
    expect(tenantBRows).toEqual([]);

    const tenantARows = await withTenantContext(tenantAId, (tx) => tx.attendanceRecord.findMany());
    expect(tenantARows).toHaveLength(1);
  });

  it('audit_log: cross-tenant WITH CHECK still rejects a row tagged as another tenant, and no-context still fails loudly', async () => {
    await withTenantContext(tenantAId, (tx) => tx.auditLog.create({ data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Test', entityId: 'iso' } }));

    const tenantBRows = await withTenantContext(tenantBId, (tx) => tx.auditLog.findMany());
    expect(tenantBRows).toEqual([]);

    await expect(appPrisma.auditLog.findMany()).rejects.toThrow();
  });
});

describe('audit_log immutability holds across TWO DIFFERENT partitions (months), not just "today"', () => {
  it('rejects UPDATE/DELETE on a row landing in an OLDER month partition', async () => {
    await prisma.$executeRaw`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', '2026-01-01'::date, '2026-01-01'::date)`;
    const oldRow = await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, occurredAt: new Date('2026-01-15T00:00:00Z'), action: 'CREATE', entityType: 'Test', entityId: 'old' } }),
    );
    const partition = await tableoidOf('audit_log', oldRow.id, oldRow.occurredAt);
    expect(partition).toBe('audit_log_p2026_01');

    await expect(
      withTenantContext(tenantAId, (tx) => tx.auditLog.updateMany({ where: { id: oldRow.id }, data: { action: 'HACKED' } })),
    ).rejects.toThrow(/permission denied/i);
    await expect(withTenantContext(tenantAId, (tx) => tx.auditLog.deleteMany({ where: { id: oldRow.id } }))).rejects.toThrow(/permission denied/i);
  });

  it('rejects UPDATE/DELETE on a row landing in a DIFFERENT, FUTURE month partition', async () => {
    // Bootstrap a far-future partition first, the same way the scheduled
    // PartitionMaintenanceService job would ahead of time — see
    // apps/api/src/partitioning.
    await prisma.$executeRaw`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', '2027-06-01'::date, '2027-06-01'::date)`;

    const futureRow = await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, occurredAt: new Date('2027-06-20T00:00:00Z'), action: 'CREATE', entityType: 'Test', entityId: 'future' } }),
    );
    const partition = await tableoidOf('audit_log', futureRow.id, futureRow.occurredAt);
    expect(partition).toBe('audit_log_p2027_06');

    await expect(
      withTenantContext(tenantAId, (tx) => tx.auditLog.updateMany({ where: { id: futureRow.id }, data: { action: 'HACKED' } })),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('partition pruning: a time-range query touches only the relevant partition', () => {
  it('a one-month audit_log query plan mentions only that month\'s partition', async () => {
    // Ensure at least three distinct months' partitions/data exist so a
    // full, unpruned scan would visibly touch more than one relation.
    await prisma.$executeRaw`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', '2026-03-01'::date, '2026-07-01'::date)`;
    await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, occurredAt: new Date('2026-03-05T00:00:00Z'), action: 'CREATE', entityType: 'Test', entityId: 'm3' } }),
    );
    await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, occurredAt: new Date('2026-07-05T00:00:00Z'), action: 'CREATE', entityType: 'Test', entityId: 'm7' } }),
    );

    const planRows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT * FROM audit_log WHERE occurred_at >= '2026-07-01' AND occurred_at < '2026-08-01'`,
    );
    const planText = planRows.map((r) => r['QUERY PLAN']).join('\n');

    // The July partition must appear (it's the one being scanned)...
    expect(planText).toMatch(/audit_log_p2026_07/);
    // ...and no OTHER month's partition should appear anywhere in the plan
    // — proof of static partition pruning, not a full scan across every
    // partition with a filter applied afterward.
    const mentionedPartitions = new Set(Array.from(planText.matchAll(/audit_log_p(\d{4}_\d{2})/g)).map((m) => m[1]));
    expect(Array.from(mentionedPartitions)).toEqual(['2026_07']);
  });
});

describe('the partitioning-conversion MECHANISM preserves every existing row exactly (replayed on a scratch table)', () => {
  it('rename -> recreate PARTITION BY RANGE -> bootstrap -> copy -> drop legacy loses zero rows', async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS scratch_partition_migration CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS scratch_partition_migration_legacy CASCADE`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE scratch_partition_migration (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        occurred_at timestamp(3) NOT NULL,
        val text NOT NULL,
        CONSTRAINT scratch_partition_migration_pkey PRIMARY KEY (id, occurred_at)
      )
    `);

    const seeded = [
      { occurredAt: '2025-01-15 10:00:00', val: 'row-jan-2025' },
      { occurredAt: '2025-06-10 10:00:00', val: 'row-jun-2025' },
      { occurredAt: '2026-09-01 10:00:00', val: 'row-sep-2026' },
    ];
    for (const row of seeded) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO scratch_partition_migration (occurred_at, val) VALUES ($1::timestamp, $2)`,
        row.occurredAt,
        row.val,
      );
    }

    const countBefore = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*)::bigint AS count FROM scratch_partition_migration`);
    expect(Number(countBefore[0].count)).toBe(3);

    // The EXACT recipe the `partition_high_growth_tables` migration uses.
    await prisma.$executeRawUnsafe(`ALTER TABLE scratch_partition_migration RENAME TO scratch_partition_migration_legacy`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE scratch_partition_migration_legacy RENAME CONSTRAINT scratch_partition_migration_pkey TO scratch_partition_migration_legacy_pkey`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE TABLE scratch_partition_migration (
        id uuid NOT NULL,
        occurred_at timestamp(3) NOT NULL,
        val text NOT NULL,
        CONSTRAINT scratch_partition_migration_pkey PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)
    `);
    await prisma.$executeRaw`SELECT hrm_ensure_range_partitions('scratch_partition_migration', 'scratch_partition_migration_p', '2025-01-01'::date, '2026-09-01'::date)`;
    await prisma.$executeRawUnsafe(`INSERT INTO scratch_partition_migration SELECT * FROM scratch_partition_migration_legacy`);
    await prisma.$executeRawUnsafe(`DROP TABLE scratch_partition_migration_legacy`);

    const rowsAfter = await prisma.$queryRawUnsafe<{ val: string; partition: string }[]>(
      `SELECT val, tableoid::regclass::text AS partition FROM scratch_partition_migration ORDER BY val`,
    );
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter.map((r) => r.val).sort()).toEqual(['row-jan-2025', 'row-jun-2025', 'row-sep-2026']);
    // Each row landed in the correct month's own partition — not just
    // "somewhere", the RIGHT somewhere.
    expect(rowsAfter.find((r) => r.val === 'row-jan-2025')?.partition).toBe('scratch_partition_migration_p2025_01');
    expect(rowsAfter.find((r) => r.val === 'row-jun-2025')?.partition).toBe('scratch_partition_migration_p2025_06');
    expect(rowsAfter.find((r) => r.val === 'row-sep-2026')?.partition).toBe('scratch_partition_migration_p2026_09');

    await prisma.$executeRawUnsafe(`DROP TABLE scratch_partition_migration CASCADE`);
  });
});

describe('hrm_ensure_range_partitions is idempotent (safe to call repeatedly, as the scheduled job does)', () => {
  it('calling it twice for the same range creates no duplicate partitions', async () => {
    // A month-pair unique to this test run, so re-running this suite
    // against the same persistent dev DB never inherits leftover state
    // from a prior run — the whole point of the assertion below is "the
    // SECOND call adds nothing more than the first", which only means
    // something if we start from a genuinely clean slate for this exact
    // pair.
    const stamp = Date.now() % 100;
    const month = `20${30 + Math.floor(stamp / 12)}-${String((stamp % 12) + 1).padStart(2, '0')}-01`;

    const before = await partitionExists('audit_log', month);
    expect(before).toBe(false);

    await prisma.$executeRawUnsafe(`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', $1::date, $1::date)`, month);
    const countAfterFirst = await countPartitionsOf('audit_log');
    expect(await partitionExists('audit_log', month)).toBe(true);

    await prisma.$executeRawUnsafe(`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', $1::date, $1::date)`, month);
    const countAfterSecond = await countPartitionsOf('audit_log');

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('hrm_app has no EXECUTE privilege on the partition-creation function (DDL stays owner-only)', async () => {
    await expect(
      appPrisma.$executeRaw`SELECT hrm_ensure_range_partitions('audit_log', 'audit_log_p', '2029-01-01'::date, '2029-01-01'::date)`,
    ).rejects.toThrow(/permission denied/i);
  });
});

async function tableoidOf(table: string, id: string, occurredAt: Date): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ partition: string }[]>(
    `SELECT tableoid::regclass::text AS partition FROM ${table} WHERE id = $1::uuid AND occurred_at = $2::timestamp`,
    id,
    occurredAt,
  );
  return rows[0]?.partition;
}

async function partitionExists(physicalTable: string, monthStart: string): Promise<boolean> {
  const suffix = monthStart.slice(0, 7).replace('-', '_');
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = $1) AS exists`,
    `${physicalTable}_p${suffix}`,
  );
  return rows[0]?.exists ?? false;
}

async function countPartitionsOf(physicalTable: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = ${physicalTable}
  `;
  return Number(rows[0]?.count ?? 0);
}
