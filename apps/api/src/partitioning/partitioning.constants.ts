import type { PartitionedTableName } from '@hrm/db';

/**
 * Table partitioning + archival (step 5.2) — see
 * docs/conventions/partitioning-archival.md. Two independent scheduled
 * BullMQ jobs, the SAME "orchestrate -> fan out" shape every prior
 * scheduled job in this codebase (AnalyticsRollupService, LMS's rollup/
 * expiry jobs, BillingSeatMeteringService) already establishes — see
 * AnalyticsRollupService's own doc comment for the full write-up not
 * repeated here.
 */
export const PARTITION_MAINTENANCE_ORCHESTRATOR_JOB_ID = 'partition-maintenance-daily-orchestrator';
/** Daily — offset from every other scheduled job's cron (analytics 0 2, LMS 0 3 / 0 4, billing seat-sync 0 4) so they don't all fire the same minute. */
export const PARTITION_MAINTENANCE_ORCHESTRATOR_CRON = '0 1 * * *';

export const PARTITION_ARCHIVAL_ORCHESTRATOR_JOB_ID = 'partition-archival-monthly-orchestrator';
/**
 * Monthly (1st of the month, 05:00 UTC) — archival only ever acts once a
 * partition has aged past a MONTHS-long retention window, so running it
 * more than daily buys nothing; monthly keeps the sweep cheap and its
 * blast radius (one detach+export+drop per eligible partition) predictable.
 */
export const PARTITION_ARCHIVAL_ORCHESTRATOR_CRON = '0 5 1 * *';

export interface PartitionedTableSpec {
  tableName: PartitionedTableName;
  /** The real Postgres table name (snake_case) — matches schema.prisma's `@@map`. */
  physicalTable: string;
  /** Prefix every monthly partition of this table is named with, e.g. `"audit_log_p"` -> `"audit_log_p2026_09"`. */
  partitionPrefix: string;
  /** Whether this table carries a `tenant_id` column — an archived export of a tenant-scoped table is inherently cross-tenant (spans every tenant's rows for that date range); a platform-only table's export is simply the whole table's slice. */
  tenantScoped: boolean;
}

/**
 * THE registry of every table this module manages — the ONE place a future
 * fourth partitioned table would be added (a new spec entry plus, if it's
 * genuinely new, the matching native-partitioning migration in
 * packages/db). `PartitionMaintenanceService`/`PartitionArchivalService`/
 * `PartitionStatusService` all iterate this list rather than each
 * hardcoding their own copy of "which tables are partitioned."
 */
export const PARTITIONED_TABLES: readonly PartitionedTableSpec[] = [
  { tableName: 'ATTENDANCE_RECORDS', physicalTable: 'attendance_records', partitionPrefix: 'attendance_records_p', tenantScoped: true },
  { tableName: 'AUDIT_LOG', physicalTable: 'audit_log', partitionPrefix: 'audit_log_p', tenantScoped: true },
  { tableName: 'PLATFORM_AUDIT_LOG', physicalTable: 'platform_audit_log', partitionPrefix: 'platform_audit_log_p', tenantScoped: false },
];

/** A monthly-named partition, e.g. `attendance_records_p2026_09`, matches `<prefix><4 digits>_<2 digits>` exactly — used to validate a partition name read back from `pg_class` before ever interpolating it into a raw SQL identifier (defense-in-depth: these names come from Postgres system catalogs, never user input, but every dynamic-identifier code path in this module still validates first, the same "no single layer trusted alone" posture the rest of this codebase holds itself to). */
export function isWellFormedPartitionName(prefix: string, name: string): boolean {
  const pattern = new RegExp(`^${prefix}\\d{4}_\\d{2}$`);
  return pattern.test(name);
}
