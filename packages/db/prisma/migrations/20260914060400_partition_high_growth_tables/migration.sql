-- Table partitioning (step 5.2, Phase 5) — see
-- docs/conventions/partitioning-archival.md for the full write-up. Converts
-- attendance_records (1.3), audit_log (0.9), and platform_audit_log (4.1)
-- from ordinary tables into REAL Postgres native `PARTITION BY RANGE` tables
-- — the migration all three were deliberately built PARTITION-READY for
-- (composite `(id, <partition column>)` primary keys) since their own
-- original steps. This is an ADDITIVE conversion: every existing row is
-- preserved (moved into the correct partition), every existing index/FK/RLS
-- policy/grant is recreated identically, and NOTHING about how callers
-- query/write these tables changes — Prisma (and every service in
-- apps/api) keeps addressing them by their ONE, unchanged table name; it has
-- no idea partitions exist underneath, exactly as intended.
--
-- Prisma has no partitioning DSL (the same reason RLS itself is hand-written
-- SQL — see docs/conventions/tenancy-rls.md), so this whole migration is raw
-- SQL with no corresponding schema.prisma model change: the three models'
-- columns/PK/indexes are already exactly this shape in schema.prisma.
--
-- ===========================================================================
-- 1. The reusable partition-management function.
--
-- `hrm_ensure_range_partitions` creates any MONTHLY partitions between
-- `p_from_month` and `p_to_month` (inclusive) that don't already exist —
-- idempotent by construction (checks `pg_class`/`pg_namespace` first), so
-- calling it repeatedly (this migration's own bootstrap below, AND the
-- Phase 5.2 `PartitionMaintenanceService` scheduled BullMQ job at runtime —
-- see apps/api/src/partitioning) never errors or creates duplicates. This is
-- the ONE place partition-creation DDL is expressed — the migration's own
-- bootstrap and the ongoing runtime job both call this same function rather
-- than each re-implementing "loop month-by-month and CREATE TABLE ...
-- PARTITION OF" independently.
--
-- Deliberately NOT granted to `hrm_app` (see the explicit REVOKE at the
-- bottom of this section) — creating a partition is DDL, and `hrm_app` only
-- ever holds DML grants (see docs/conventions/tenancy-rls.md's two-DB-role
-- design) plus bare `USAGE` on the schema, never `CREATE`. Every caller of
-- this function — this migration, and `PartitionMaintenanceService`/
-- `PartitionArchivalService` at runtime — goes through the OWNER `prisma`
-- client, never `appPrisma`/`withTenantContext`. The REVOKE is explicit,
-- defense-in-depth on top of that structural fact, the same "don't rely on
-- absence of a GRANT alone" posture the audit_log immutability migration
-- already takes for itself.
CREATE OR REPLACE FUNCTION hrm_ensure_range_partitions(
  p_parent_table text,
  p_partition_prefix text,
  p_from_month date,
  p_to_month date
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_month date := date_trunc('month', p_from_month)::date;
  final_month  date := date_trunc('month', p_to_month)::date;
  partition_name text;
  range_start date;
  range_end   date;
BEGIN
  IF cursor_month > final_month THEN
    RETURN;
  END IF;

  WHILE cursor_month <= final_month LOOP
    range_start := cursor_month;
    range_end   := (cursor_month + INTERVAL '1 month')::date;
    partition_name := p_partition_prefix || to_char(cursor_month, 'YYYY_MM');

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = partition_name AND n.nspname = current_schema()
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        partition_name, p_parent_table, range_start, range_end
      );
    END IF;

    cursor_month := (cursor_month + INTERVAL '1 month')::date;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION hrm_ensure_range_partitions(text, text, date, date) FROM PUBLIC;

-- ===========================================================================
-- 2. attendance_records — PARTITION BY RANGE (work_date), monthly.

ALTER TABLE "attendance_records" RENAME TO "attendance_records_legacy";
ALTER TABLE "attendance_records_legacy" RENAME CONSTRAINT "attendance_records_pkey" TO "attendance_records_legacy_pkey";
ALTER TABLE "attendance_records_legacy" RENAME CONSTRAINT "attendance_records_tenant_id_fkey" TO "attendance_records_legacy_tenant_id_fkey";
ALTER TABLE "attendance_records_legacy" RENAME CONSTRAINT "attendance_records_tenant_id_employee_id_fkey" TO "attendance_records_legacy_tenant_id_employee_id_fkey";
ALTER TABLE "attendance_records_legacy" RENAME CONSTRAINT "attendance_records_tenant_id_branch_id_fkey" TO "attendance_records_legacy_tenant_id_branch_id_fkey";
ALTER INDEX "attendance_records_tenant_id_employee_id_work_date_idx" RENAME TO "attendance_records_legacy_tenant_id_employee_id_work_date_idx";
ALTER INDEX "attendance_records_tenant_id_branch_id_work_date_idx" RENAME TO "attendance_records_legacy_tenant_id_branch_id_work_date_idx";
ALTER INDEX "attendance_records_tenant_id_employee_id_status_idx" RENAME TO "attendance_records_legacy_tenant_id_employee_id_status_idx";

CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "shift_definition_id" UUID,
    "clock_in_at" TIMESTAMP(3) NOT NULL,
    "clock_in_source" "AttendanceSource" NOT NULL,
    "clock_in_lat" DOUBLE PRECISION,
    "clock_in_long" DOUBLE PRECISION,
    "clock_in_photo_key" TEXT,
    "clock_out_at" TIMESTAMP(3),
    "clock_out_source" "AttendanceSource",
    "clock_out_lat" DOUBLE PRECISION,
    "clock_out_long" DOUBLE PRECISION,
    "clock_out_photo_key" TEXT,
    "status" "AttendanceRecordStatus" NOT NULL DEFAULT 'OPEN',
    "worked_minutes" INTEGER,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id", "work_date"),
    CONSTRAINT "attendance_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attendance_records_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attendance_records_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
) PARTITION BY RANGE ("work_date");

CREATE INDEX "attendance_records_tenant_id_employee_id_work_date_idx" ON "attendance_records"("tenant_id", "employee_id", "work_date");
CREATE INDEX "attendance_records_tenant_id_branch_id_work_date_idx" ON "attendance_records"("tenant_id", "branch_id", "work_date");
CREATE INDEX "attendance_records_tenant_id_employee_id_status_idx" ON "attendance_records"("tenant_id", "employee_id", "status");

-- Bootstrap partitions covering every existing row PLUS a generous fixed
-- window: at least the whole CURRENT CALENDAR YEAR through Q1 of next year
-- (not just "current month +/- a little") — chosen deliberately wide, not
-- merely "current month - 1 .. current month + 3", because a real-world
-- migration run also has to accommodate rows/fixtures dated anywhere across
-- the current year (a backfill, a fixed-date test fixture, a January-dated
-- record migrated in September) that a narrower, purely "around today"
-- window would miss — extended further still if real historical/future
-- data requires it.
DO $$
DECLARE
  min_date date;
  max_date date;
  from_month date;
  to_month date;
BEGIN
  SELECT COALESCE(MIN("work_date"), CURRENT_DATE), COALESCE(MAX("work_date"), CURRENT_DATE)
    INTO min_date, max_date
    FROM "attendance_records_legacy";

  from_month := LEAST(date_trunc('month', min_date - INTERVAL '1 month'), date_trunc('year', CURRENT_DATE))::date;
  to_month   := GREATEST(date_trunc('month', max_date + INTERVAL '3 months'), (date_trunc('year', CURRENT_DATE) + INTERVAL '1 year 3 months'))::date;

  PERFORM hrm_ensure_range_partitions('attendance_records', 'attendance_records_p', from_month, to_month);
END $$;

INSERT INTO "attendance_records" SELECT * FROM "attendance_records_legacy";

DROP TABLE "attendance_records_legacy";

GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_records" TO hrm_app;

ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "attendance_records"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- ===========================================================================
-- 3. audit_log — PARTITION BY RANGE (occurred_at), monthly. Same DB-level
-- immutability guarantee (SELECT/INSERT only, UPDATE/DELETE explicitly
-- REVOKEd) as before partitioning — see docs/conventions/audit-custom-fields.md.
-- Proven directly (not just carried over by assumption) in
-- packages/db/test/partitioning.spec.ts.

ALTER TABLE "audit_log" RENAME TO "audit_log_legacy";
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_pkey" TO "audit_log_legacy_pkey";
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_tenant_id_fkey" TO "audit_log_legacy_tenant_id_fkey";
ALTER INDEX "audit_log_tenant_id_occurred_at_idx" RENAME TO "audit_log_legacy_tenant_id_occurred_at_idx";
ALTER INDEX "audit_log_tenant_id_entity_type_entity_id_idx" RENAME TO "audit_log_legacy_tenant_id_entity_type_entity_id_idx";
ALTER INDEX "audit_log_tenant_id_actor_user_id_idx" RENAME TO "audit_log_legacy_tenant_id_actor_user_id_idx";

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_platform" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id", "occurred_at"),
    CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log"("tenant_id", "occurred_at");
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");
CREATE INDEX "audit_log_tenant_id_actor_user_id_idx" ON "audit_log"("tenant_id", "actor_user_id");

DO $$
DECLARE
  min_date date;
  max_date date;
  from_month date;
  to_month date;
BEGIN
  SELECT COALESCE(MIN("occurred_at")::date, CURRENT_DATE), COALESCE(MAX("occurred_at")::date, CURRENT_DATE)
    INTO min_date, max_date
    FROM "audit_log_legacy";

  from_month := LEAST(date_trunc('month', min_date - INTERVAL '1 month'), date_trunc('year', CURRENT_DATE))::date;
  to_month   := GREATEST(date_trunc('month', max_date + INTERVAL '3 months'), (date_trunc('year', CURRENT_DATE) + INTERVAL '1 year 3 months'))::date;

  PERFORM hrm_ensure_range_partitions('audit_log', 'audit_log_p', from_month, to_month);
END $$;

INSERT INTO "audit_log" SELECT * FROM "audit_log_legacy";

DROP TABLE "audit_log_legacy";

GRANT SELECT, INSERT ON "audit_log" TO hrm_app;
REVOKE UPDATE, DELETE ON "audit_log" FROM hrm_app;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_log"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- ===========================================================================
-- 4. platform_audit_log — PARTITION BY RANGE (occurred_at), monthly. No
-- tenant_id, no RLS, and NO grant to hrm_app at all — same exemption as
-- before partitioning (see the `add_platform_vendor_console` migration);
-- only the owner `prisma` client, via @PlatformRoute() services, ever
-- touches this table.

ALTER TABLE "platform_audit_log" RENAME TO "platform_audit_log_legacy";
ALTER TABLE "platform_audit_log_legacy" RENAME CONSTRAINT "platform_audit_log_pkey" TO "platform_audit_log_legacy_pkey";
ALTER INDEX "platform_audit_log_occurred_at_idx" RENAME TO "platform_audit_log_legacy_occurred_at_idx";
ALTER INDEX "platform_audit_log_platform_admin_id_occurred_at_idx" RENAME TO "platform_audit_log_legacy_platform_admin_id_occurred_at_idx";
ALTER INDEX "platform_audit_log_target_tenant_id_occurred_at_idx" RENAME TO "platform_audit_log_legacy_target_tenant_id_occurred_at_idx";

CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform_admin_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "target_tenant_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "platform_audit_log_occurred_at_idx" ON "platform_audit_log"("occurred_at");
CREATE INDEX "platform_audit_log_platform_admin_id_occurred_at_idx" ON "platform_audit_log"("platform_admin_id", "occurred_at");
CREATE INDEX "platform_audit_log_target_tenant_id_occurred_at_idx" ON "platform_audit_log"("target_tenant_id", "occurred_at");

DO $$
DECLARE
  min_date date;
  max_date date;
  from_month date;
  to_month date;
BEGIN
  SELECT COALESCE(MIN("occurred_at")::date, CURRENT_DATE), COALESCE(MAX("occurred_at")::date, CURRENT_DATE)
    INTO min_date, max_date
    FROM "platform_audit_log_legacy";

  from_month := LEAST(date_trunc('month', min_date - INTERVAL '1 month'), date_trunc('year', CURRENT_DATE))::date;
  to_month   := GREATEST(date_trunc('month', max_date + INTERVAL '3 months'), (date_trunc('year', CURRENT_DATE) + INTERVAL '1 year 3 months'))::date;

  PERFORM hrm_ensure_range_partitions('platform_audit_log', 'platform_audit_log_p', from_month, to_month);
END $$;

INSERT INTO "platform_audit_log" SELECT * FROM "platform_audit_log_legacy";

DROP TABLE "platform_audit_log_legacy";
