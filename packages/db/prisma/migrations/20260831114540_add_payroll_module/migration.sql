-- CreateEnum
CREATE TYPE "PayrollComponentType" AS ENUM ('EARNING', 'ALLOWANCE', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollComponentCalcKind" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE_OF_BASE', 'FORMULA');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATED', 'APPROVED', 'FINALIZED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollRunLineStatus" AS ENUM ('PENDING', 'COMPUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayrollComputedVia" AS ENUM ('ENGINE', 'DELEGATE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "base_currency_code" VARCHAR(3) NOT NULL DEFAULT 'USD';

-- CreateTable
CREATE TABLE "payroll_component_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PayrollComponentType" NOT NULL,
    "calc_kind" "PayrollComponentCalcKind" NOT NULL,
    "fixed_amount" DECIMAL(14,2),
    "percentage_of_base" TEXT,
    "percentage_rate" DOUBLE PRECISION,
    "formula" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_component_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "base_currency" VARCHAR(3) NOT NULL,
    "quote_currency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "as_of_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "payroll_mode" VARCHAR(16) NOT NULL,
    "workflow_instance_id" UUID,
    "currency_code" VARCHAR(3) NOT NULL,
    "exchange_rate_to_base" DECIMAL(18,8),
    "total_gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_employer_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_gross_base" DECIMAL(14,2),
    "total_net_base" DECIMAL(14,2),
    "created_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payroll_run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "PayrollRunLineStatus" NOT NULL DEFAULT 'PENDING',
    "computed_via" "PayrollComputedVia",
    "gross_pay" DECIMAL(14,2),
    "net_pay" DECIMAL(14,2),
    "employer_cost" DECIMAL(14,2),
    "component_breakdown" JSONB,
    "error_message" TEXT,
    "computed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_run_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payroll_run_line_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "language" VARCHAR(8) NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_bank_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payroll_run_id" UUID NOT NULL,
    "format" VARCHAR(32) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "generated_by_user_id" UUID NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_bank_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_component_definitions_tenant_id_country_code_is_act_idx" ON "payroll_component_definitions"("tenant_id", "country_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_component_definitions_tenant_id_country_code_key_key" ON "payroll_component_definitions"("tenant_id", "country_code", "key");

-- CreateIndex
CREATE INDEX "exchange_rates_base_currency_quote_currency_as_of_date_idx" ON "exchange_rates"("base_currency", "quote_currency", "as_of_date");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_currency_quote_currency_as_of_date_key" ON "exchange_rates"("base_currency", "quote_currency", "as_of_date");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_branch_id_period_year_period_month_idx" ON "payroll_runs"("tenant_id", "branch_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenant_id_id_key" ON "payroll_runs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenant_id_branch_id_period_year_period_month_key" ON "payroll_runs"("tenant_id", "branch_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "payroll_run_lines_tenant_id_payroll_run_id_status_idx" ON "payroll_run_lines"("tenant_id", "payroll_run_id", "status");

-- CreateIndex
CREATE INDEX "payroll_run_lines_tenant_id_employee_id_idx" ON "payroll_run_lines"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_lines_tenant_id_id_key" ON "payroll_run_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_lines_tenant_id_payroll_run_id_employee_id_key" ON "payroll_run_lines"("tenant_id", "payroll_run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslip_documents_tenant_id_payroll_run_line_id_key" ON "payslip_documents"("tenant_id", "payroll_run_line_id");

-- CreateIndex
CREATE INDEX "payroll_bank_exports_tenant_id_payroll_run_id_idx" ON "payroll_bank_exports"("tenant_id", "payroll_run_id");

-- AddForeignKey
ALTER TABLE "payroll_component_definitions" ADD CONSTRAINT "payroll_component_definitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_tenant_id_payroll_run_id_fkey" FOREIGN KEY ("tenant_id", "payroll_run_id") REFERENCES "payroll_runs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_documents" ADD CONSTRAINT "payslip_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_documents" ADD CONSTRAINT "payslip_documents_tenant_id_payroll_run_line_id_fkey" FOREIGN KEY ("tenant_id", "payroll_run_line_id") REFERENCES "payroll_run_lines"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_bank_exports" ADD CONSTRAINT "payroll_bank_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_bank_exports" ADD CONSTRAINT "payroll_bank_exports_tenant_id_payroll_run_id_fkey" FOREIGN KEY ("tenant_id", "payroll_run_id") REFERENCES "payroll_runs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
