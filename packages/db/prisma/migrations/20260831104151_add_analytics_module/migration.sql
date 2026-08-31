-- CreateEnum
CREATE TYPE "WorkforceMovementType" AS ENUM ('JOINER', 'LEAVER');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "terminated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "headcount_daily_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "employment_type" "EmploymentType" NOT NULL,
    "gender" "Gender",
    "active_count" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "headcount_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_movement_daily_counts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "movement_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "movement_type" "WorkforceMovementType" NOT NULL,
    "count" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workforce_movement_daily_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_daily_branch_summaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "present_count" INTEGER NOT NULL DEFAULT 0,
    "absent_count" INTEGER NOT NULL DEFAULT 0,
    "late_count" INTEGER NOT NULL DEFAULT 0,
    "on_leave_count" INTEGER NOT NULL DEFAULT 0,
    "weekend_count" INTEGER NOT NULL DEFAULT 0,
    "holiday_count" INTEGER NOT NULL DEFAULT 0,
    "total_worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "total_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "total_late_minutes" INTEGER NOT NULL DEFAULT 0,
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_daily_branch_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_utilization_daily_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "leave_type" "LeaveType" NOT NULL,
    "total_entitled_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_accrued_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_used_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_utilization_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "headcount_daily_snapshots_tenant_id_snapshot_date_branch_id_idx" ON "headcount_daily_snapshots"("tenant_id", "snapshot_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "headcount_daily_snapshots_tenant_id_snapshot_date_branch_id_key" ON "headcount_daily_snapshots"("tenant_id", "snapshot_date", "branch_id", "department_id", "employment_type", "gender");

-- CreateIndex
CREATE INDEX "workforce_movement_daily_counts_tenant_id_movement_date_bra_idx" ON "workforce_movement_daily_counts"("tenant_id", "movement_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "workforce_movement_daily_counts_tenant_id_movement_date_bra_key" ON "workforce_movement_daily_counts"("tenant_id", "movement_date", "branch_id", "department_id", "movement_type");

-- CreateIndex
CREATE INDEX "attendance_daily_branch_summaries_tenant_id_work_date_branc_idx" ON "attendance_daily_branch_summaries"("tenant_id", "work_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_daily_branch_summaries_tenant_id_work_date_branc_key" ON "attendance_daily_branch_summaries"("tenant_id", "work_date", "branch_id", "department_id");

-- CreateIndex
CREATE INDEX "leave_utilization_daily_snapshots_tenant_id_snapshot_date_b_idx" ON "leave_utilization_daily_snapshots"("tenant_id", "snapshot_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_utilization_daily_snapshots_tenant_id_snapshot_date_b_key" ON "leave_utilization_daily_snapshots"("tenant_id", "snapshot_date", "branch_id", "department_id", "leave_type");

-- AddForeignKey
ALTER TABLE "headcount_daily_snapshots" ADD CONSTRAINT "headcount_daily_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headcount_daily_snapshots" ADD CONSTRAINT "headcount_daily_snapshots_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_movement_daily_counts" ADD CONSTRAINT "workforce_movement_daily_counts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_movement_daily_counts" ADD CONSTRAINT "workforce_movement_daily_counts_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily_branch_summaries" ADD CONSTRAINT "attendance_daily_branch_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily_branch_summaries" ADD CONSTRAINT "attendance_daily_branch_summaries_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_utilization_daily_snapshots" ADD CONSTRAINT "leave_utilization_daily_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_utilization_daily_snapshots" ADD CONSTRAINT "leave_utilization_daily_snapshots_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
