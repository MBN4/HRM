-- CreateEnum
CREATE TYPE "PartitionedTableName" AS ENUM ('ATTENDANCE_RECORDS', 'AUDIT_LOG', 'PLATFORM_AUDIT_LOG');

-- CreateTable
CREATE TABLE "partitioned_table_configs" (
    "table_name" "PartitionedTableName" NOT NULL,
    "lookahead_months" INTEGER NOT NULL DEFAULT 3,
    "retention_months" INTEGER NOT NULL DEFAULT 24,
    "archive_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partitioned_table_configs_pkey" PRIMARY KEY ("table_name")
);

-- CreateTable
CREATE TABLE "tenant_retention_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "table_name" "PartitionedTableName" NOT NULL,
    "retention_months" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_retention_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archived_partitions" (
    "id" UUID NOT NULL,
    "table_name" "PartitionedTableName" NOT NULL,
    "partition_name" TEXT NOT NULL,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archived_partitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_retention_overrides_tenant_id_idx" ON "tenant_retention_overrides"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_retention_overrides_tenant_id_table_name_key" ON "tenant_retention_overrides"("tenant_id", "table_name");

-- CreateIndex
CREATE INDEX "archived_partitions_table_name_range_start_idx" ON "archived_partitions"("table_name", "range_start");

-- CreateIndex
CREATE UNIQUE INDEX "archived_partitions_table_name_partition_name_key" ON "archived_partitions"("table_name", "partition_name");

-- AddForeignKey
ALTER TABLE "tenant_retention_overrides" ADD CONSTRAINT "tenant_retention_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed sane platform defaults so PartitionMaintenanceService/PartitionArchivalService
-- always have a config row to resolve, from the moment this migration runs —
-- see docs/conventions/partitioning-archival.md. `audit_log`/`platform_audit_log`
-- get a much longer retention (7 years, a common statutory-audit-trail
-- baseline) than `attendance_records` (2 years) — both are illustrative
-- defaults, the same "not a certified figure, a real admin tunes this via
-- PUT /platform/partitioning/config/:tableName" posture BILLING_PLANS/
-- seed-country-packs.ts already document for their own numbers.
INSERT INTO "partitioned_table_configs" ("table_name", "lookahead_months", "retention_months", "archive_enabled", "updated_at") VALUES
  ('ATTENDANCE_RECORDS', 3, 24, true, CURRENT_TIMESTAMP),
  ('AUDIT_LOG', 3, 84, true, CURRENT_TIMESTAMP),
  ('PLATFORM_AUDIT_LOG', 3, 84, true, CURRENT_TIMESTAMP)
ON CONFLICT ("table_name") DO NOTHING;
