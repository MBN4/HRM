-- CreateEnum
CREATE TYPE "StatutoryReportPeriodType" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "GeneratedReportStatus" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "statutory_report_definitions" (
    "id" UUID NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "report_code" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "period_type" "StatutoryReportPeriodType" NOT NULL,
    "output_formats" TEXT[],
    "compliance_note" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "statutory_report_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "report_definition_id" UUID NOT NULL,
    "report_code" VARCHAR(64) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "period_type" "StatutoryReportPeriodType" NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER,
    "period_quarter" INTEGER,
    "period_key" VARCHAR(16) NOT NULL,
    "status" "GeneratedReportStatus" NOT NULL DEFAULT 'PENDING',
    "pdf_storage_key" TEXT,
    "csv_storage_key" TEXT,
    "summary" JSONB,
    "error_message" TEXT,
    "requested_by_user_id" UUID,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statutory_report_definitions_country_code_is_active_idx" ON "statutory_report_definitions"("country_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_report_definitions_country_code_report_code_key" ON "statutory_report_definitions"("country_code", "report_code");

-- CreateIndex
CREATE INDEX "generated_reports_tenant_id_branch_id_status_idx" ON "generated_reports"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generated_reports_tenant_id_branch_id_report_definition_id__key" ON "generated_reports"("tenant_id", "branch_id", "report_definition_id", "period_key");

-- AddForeignKey
ALTER TABLE "generated_reports" ADD CONSTRAINT "generated_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_reports" ADD CONSTRAINT "generated_reports_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_reports" ADD CONSTRAINT "generated_reports_report_definition_id_fkey" FOREIGN KEY ("report_definition_id") REFERENCES "statutory_report_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
