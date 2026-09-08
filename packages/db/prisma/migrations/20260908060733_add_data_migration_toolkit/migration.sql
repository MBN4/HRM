-- CreateEnum
CREATE TYPE "ImportEntityType" AS ENUM ('BRANCH', 'DEPARTMENT', 'DESIGNATION', 'COST_CENTER', 'EMPLOYEE', 'LEAVE_BALANCE', 'ATTENDANCE_HISTORY', 'PAYSLIP_HISTORY');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('PARTIAL', 'ALL_OR_NOTHING');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'DRY_RUN_COMPLETE', 'COMMITTING', 'COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED');

-- CreateTable
CREATE TABLE "column_mapping_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" "ImportEntityType" NOT NULL,
    "mapping" JSONB NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "column_mapping_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" "ImportEntityType" NOT NULL,
    "mode" "ImportMode" NOT NULL DEFAULT 'PARTIAL',
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "file_format" VARCHAR(8) NOT NULL,
    "file_storage_key" TEXT,
    "file_purged_at" TIMESTAMP(3),
    "columnMapping" JSONB NOT NULL,
    "column_mapping_template_id" UUID,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "create_count" INTEGER NOT NULL DEFAULT 0,
    "update_count" INTEGER NOT NULL DEFAULT 0,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "dry_run_completed_at" TIMESTAMP(3),
    "committed_at" TIMESTAMP(3),
    "initiated_by_user_id" UUID,
    "initiated_by_platform_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_errors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "phase" VARCHAR(16) NOT NULL,
    "row_number" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "row_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_row_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migrated_attendance_summaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "worked_minutes" INTEGER,
    "overtime_minutes" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migrated_attendance_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migrated_payslip_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "gross_pay" DECIMAL(14,2) NOT NULL,
    "net_pay" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migrated_payslip_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "column_mapping_templates_tenant_id_entity_type_name_key" ON "column_mapping_templates"("tenant_id", "entity_type", "name");

-- CreateIndex
CREATE INDEX "import_batches_tenant_id_entity_type_status_idx" ON "import_batches"("tenant_id", "entity_type", "status");

-- CreateIndex
CREATE INDEX "import_batches_tenant_id_status_file_purged_at_idx" ON "import_batches"("tenant_id", "status", "file_purged_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_tenant_id_id_key" ON "import_batches"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "import_row_errors_tenant_id_import_batch_id_phase_row_numbe_idx" ON "import_row_errors"("tenant_id", "import_batch_id", "phase", "row_number");

-- CreateIndex
CREATE INDEX "migrated_attendance_summaries_tenant_id_employee_id_work_da_idx" ON "migrated_attendance_summaries"("tenant_id", "employee_id", "work_date");

-- CreateIndex
CREATE INDEX "migrated_payslip_records_tenant_id_employee_id_period_year__idx" ON "migrated_payslip_records"("tenant_id", "employee_id", "period_year", "period_month");

-- AddForeignKey
ALTER TABLE "column_mapping_templates" ADD CONSTRAINT "column_mapping_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_tenant_id_import_batch_id_fkey" FOREIGN KEY ("tenant_id", "import_batch_id") REFERENCES "import_batches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrated_attendance_summaries" ADD CONSTRAINT "migrated_attendance_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrated_attendance_summaries" ADD CONSTRAINT "migrated_attendance_summaries_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrated_payslip_records" ADD CONSTRAINT "migrated_payslip_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrated_payslip_records" ADD CONSTRAINT "migrated_payslip_records_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
