-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('HEALTH_INSURANCE', 'PROVIDENT_FUND', 'PENSION', 'LIFE_INSURANCE', 'BONUS_INCENTIVE', 'ALLOWANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "BenefitCostBasis" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE_OF_BASE', 'FORMULA');

-- CreateEnum
CREATE TYPE "BenefitEnrollmentStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "benefit_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "benefit_type" "BenefitType" NOT NULL,
    "description" TEXT,
    "currency_code" VARCHAR(3) NOT NULL,
    "cost_basis" "BenefitCostBasis" NOT NULL,
    "fixed_amount" DECIMAL(14,2),
    "percentage_of_base" TEXT,
    "percentage_rate" DOUBLE PRECISION,
    "formula" JSONB,
    "employee_share_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "employer_share_percent" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "has_tiers" BOOLEAN NOT NULL DEFAULT false,
    "allow_self_election" BOOLEAN NOT NULL DEFAULT false,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "affects_payroll" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_plan_tiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "employee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "employer_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_plan_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "coverage_tier_id" UUID,
    "status" "BenefitEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "enrolled_by_user_id" UUID NOT NULL,
    "workflow_instance_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrollment_dependents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "employee_dependent_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_enrollment_dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_contribution_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "payroll_run_id" UUID NOT NULL,
    "payroll_run_line_id" UUID,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "employee_amount" DECIMAL(14,2) NOT NULL,
    "employer_amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_contribution_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "benefit_plans_tenant_id_is_active_idx" ON "benefit_plans"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plans_tenant_id_id_key" ON "benefit_plans"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plans_tenant_id_code_key" ON "benefit_plans"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "benefit_plan_tiers_tenant_id_plan_id_idx" ON "benefit_plan_tiers"("tenant_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plan_tiers_tenant_id_id_key" ON "benefit_plan_tiers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plan_tiers_tenant_id_plan_id_key_key" ON "benefit_plan_tiers"("tenant_id", "plan_id", "key");

-- CreateIndex
CREATE INDEX "benefit_enrollments_tenant_id_employee_id_status_idx" ON "benefit_enrollments"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "benefit_enrollments_tenant_id_plan_id_status_idx" ON "benefit_enrollments"("tenant_id", "plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_enrollments_tenant_id_id_key" ON "benefit_enrollments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_enrollment_dependents_tenant_id_enrollment_id_emplo_key" ON "benefit_enrollment_dependents"("tenant_id", "enrollment_id", "employee_dependent_id");

-- CreateIndex
CREATE INDEX "benefit_contribution_records_tenant_id_payroll_run_id_idx" ON "benefit_contribution_records"("tenant_id", "payroll_run_id");

-- CreateIndex
CREATE INDEX "benefit_contribution_records_tenant_id_employee_id_period_y_idx" ON "benefit_contribution_records"("tenant_id", "employee_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_contribution_records_tenant_id_enrollment_id_period_key" ON "benefit_contribution_records"("tenant_id", "enrollment_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "employee_dependents_tenant_id_id_key" ON "employee_dependents"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "benefit_plans" ADD CONSTRAINT "benefit_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plan_tiers" ADD CONSTRAINT "benefit_plan_tiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plan_tiers" ADD CONSTRAINT "benefit_plan_tiers_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "benefit_plans"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "benefit_plans"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_tier_fkey" FOREIGN KEY ("tenant_id", "coverage_tier_id") REFERENCES "benefit_plan_tiers"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollment_dependents" ADD CONSTRAINT "benefit_enrollment_dependents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollment_dependents" ADD CONSTRAINT "benefit_enrollment_dependents_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "benefit_enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollment_dependents" ADD CONSTRAINT "benefit_enrollment_dependents_tenant_id_employee_dependent_fkey" FOREIGN KEY ("tenant_id", "employee_dependent_id") REFERENCES "employee_dependents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_contribution_records" ADD CONSTRAINT "benefit_contribution_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_contribution_records" ADD CONSTRAINT "benefit_contribution_records_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_contribution_records" ADD CONSTRAINT "benefit_contribution_records_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "benefit_enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

