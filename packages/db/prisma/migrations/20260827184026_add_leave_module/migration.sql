-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED');

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "period_year" INTEGER NOT NULL,
    "entitled_days" DOUBLE PRECISION NOT NULL,
    "accrued_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carried_over_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "used_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "workflow_instance_id" UUID,
    "submitted_by_user_id" UUID,
    "balance_applied" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_accrual_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "accrued_amount" DOUBLE PRECISION NOT NULL,
    "prorated_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_accrual_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_balances_tenant_id_employee_id_idx" ON "leave_balances"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_tenant_id_employee_id_leave_type_period_year_key" ON "leave_balances"("tenant_id", "employee_id", "leave_type", "period_year");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_employee_id_status_idx" ON "leave_requests"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_start_date_end_date_idx" ON "leave_requests"("tenant_id", "start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_tenant_id_id_key" ON "leave_requests"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "leave_accrual_runs_tenant_id_period_year_period_month_idx" ON "leave_accrual_runs"("tenant_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "leave_accrual_runs_tenant_id_employee_id_leave_type_period__key" ON "leave_accrual_runs"("tenant_id", "employee_id", "leave_type", "period_year", "period_month");

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_accrual_runs" ADD CONSTRAINT "leave_accrual_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_accrual_runs" ADD CONSTRAINT "leave_accrual_runs_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

