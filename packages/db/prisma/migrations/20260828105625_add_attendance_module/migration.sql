-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('WEB', 'MOBILE', 'BIOMETRIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttendanceRecordStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttendanceRegularizationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AttendanceDayStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'WEEKEND', 'HOLIDAY');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "geofence_lat" DOUBLE PRECISION,
ADD COLUMN     "geofence_long" DOUBLE PRECISION,
ADD COLUMN     "geofence_radius_meters" INTEGER;

-- CreateTable
CREATE TABLE "shift_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "crosses_midnight" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_definition_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id","work_date")
);

-- CreateTable
CREATE TABLE "attendance_regularizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_record_id" UUID,
    "work_date" DATE NOT NULL,
    "requested_clock_in_at" TIMESTAMP(3),
    "requested_clock_out_at" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" "AttendanceRegularizationStatus" NOT NULL DEFAULT 'PENDING',
    "workflow_instance_id" UUID,
    "submitted_by_user_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_regularizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_daily_summaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "status" "AttendanceDayStatus" NOT NULL,
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_tenant_id_id_key" ON "shift_definitions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_tenant_id_name_key" ON "shift_definitions"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "roster_assignments_tenant_id_employee_id_effective_from_idx" ON "roster_assignments"("tenant_id", "employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "roster_assignments_tenant_id_id_key" ON "roster_assignments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_employee_id_work_date_idx" ON "attendance_records"("tenant_id", "employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_branch_id_work_date_idx" ON "attendance_records"("tenant_id", "branch_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_employee_id_status_idx" ON "attendance_records"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "attendance_regularizations_tenant_id_employee_id_status_idx" ON "attendance_regularizations"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_regularizations_tenant_id_id_key" ON "attendance_regularizations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "attendance_daily_summaries_tenant_id_branch_id_work_date_idx" ON "attendance_daily_summaries"("tenant_id", "branch_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_daily_summaries_tenant_id_work_date_status_idx" ON "attendance_daily_summaries"("tenant_id", "work_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_daily_summaries_tenant_id_employee_id_work_date_key" ON "attendance_daily_summaries"("tenant_id", "employee_id", "work_date");

-- AddForeignKey
ALTER TABLE "shift_definitions" ADD CONSTRAINT "shift_definitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_tenant_id_shift_definition_id_fkey" FOREIGN KEY ("tenant_id", "shift_definition_id") REFERENCES "shift_definitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily_summaries" ADD CONSTRAINT "attendance_daily_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily_summaries" ADD CONSTRAINT "attendance_daily_summaries_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily_summaries" ADD CONSTRAINT "attendance_daily_summaries_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
