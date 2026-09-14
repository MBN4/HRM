/**
 * Table partitioning + archival (step 5.2) — see
 * docs/conventions/partitioning-archival.md.
 *
 * Mirrors Prisma's `PartitionedTableName` enum (packages/db/prisma/schema.prisma)
 * — the same "closed set duplicated as a plain constant so packages/shared's
 * zod validators don't need to import the generated Prisma client" pattern
 * `TENANT_EDITIONS`/`SYSTEM_ROLES` already establish for their own Prisma
 * enums. Kept in sync by hand; a mismatch here would only ever surface as a
 * rejected request (zod validation), never a silent data bug — every actual
 * database write still goes through the real, Prisma-typed enum column.
 */
export const PARTITIONED_TABLE_NAMES = ['ATTENDANCE_RECORDS', 'AUDIT_LOG', 'PLATFORM_AUDIT_LOG'] as const;
export type PartitionedTableNameKey = (typeof PARTITIONED_TABLE_NAMES)[number];
