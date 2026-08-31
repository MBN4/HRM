-- CreateEnum
CREATE TYPE "AppraisalCycleType" AS ENUM ('ANNUAL', 'QUARTERLY', 'PROBATION');

-- CreateEnum
CREATE TYPE "AppraisalCycleStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "GoalLevel" AS ENUM ('COMPANY', 'TEAM', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'AT_RISK', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AppraisalStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'PENDING_SIGNOFF', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewType" AS ENUM ('SELF', 'MANAGER', 'PEER', 'UPWARD');

-- CreateEnum
CREATE TYPE "ReviewAssignmentStatus" AS ENUM ('PENDING', 'SUBMITTED');

-- CreateTable
CREATE TABLE "rating_scales" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "levels" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rating_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appraisal_cycles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cycle_type" "AppraisalCycleType" NOT NULL,
    "status" "AppraisalCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "rating_scale_id" UUID NOT NULL,
    "enabled_review_types" JSONB NOT NULL,
    "eligible_branch_ids" JSONB NOT NULL DEFAULT '[]',
    "eligible_department_ids" JSONB NOT NULL DEFAULT '[]',
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appraisal_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level" "GoalLevel" NOT NULL,
    "employee_id" UUID,
    "department_id" UUID,
    "parent_goal_id" UUID,
    "cycle_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "target_value" DOUBLE PRECISION,
    "current_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "progress_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "GoalStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appraisals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "AppraisalStatus" NOT NULL DEFAULT 'DRAFT',
    "overall_rating" DOUBLE PRECISION,
    "workflow_instance_id" UUID,
    "submitted_for_approval_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appraisals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "appraisal_id" UUID NOT NULL,
    "review_type" "ReviewType" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "status" "ReviewAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "appraisal_id" UUID NOT NULL,
    "review_type" "ReviewType" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "rating_scale_id" UUID NOT NULL,
    "overall_rating" DOUBLE PRECISION NOT NULL,
    "strengths" TEXT,
    "improvements" TEXT,
    "comments" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appraisal_rating_distribution_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "rating_value" DOUBLE PRECISION NOT NULL,
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appraisal_rating_distribution_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rating_scales_tenant_id_id_key" ON "rating_scales"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rating_scales_tenant_id_key_key" ON "rating_scales"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "appraisal_cycles_tenant_id_status_idx" ON "appraisal_cycles"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "appraisal_cycles_tenant_id_rating_scale_id_idx" ON "appraisal_cycles"("tenant_id", "rating_scale_id");

-- CreateIndex
CREATE UNIQUE INDEX "appraisal_cycles_tenant_id_id_key" ON "appraisal_cycles"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "goals_tenant_id_employee_id_idx" ON "goals"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "goals_tenant_id_department_id_idx" ON "goals"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "goals_tenant_id_parent_goal_id_idx" ON "goals"("tenant_id", "parent_goal_id");

-- CreateIndex
CREATE INDEX "goals_tenant_id_cycle_id_idx" ON "goals"("tenant_id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "goals_tenant_id_id_key" ON "goals"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "appraisals_tenant_id_status_idx" ON "appraisals"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "appraisals_tenant_id_employee_id_idx" ON "appraisals"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "appraisals_tenant_id_id_key" ON "appraisals"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "appraisals_tenant_id_cycle_id_employee_id_key" ON "appraisals"("tenant_id", "cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "review_assignments_tenant_id_reviewer_id_status_idx" ON "review_assignments"("tenant_id", "reviewer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_assignments_tenant_id_id_key" ON "review_assignments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "review_assignments_tenant_id_appraisal_id_review_type_revie_key" ON "review_assignments"("tenant_id", "appraisal_id", "review_type", "reviewer_id");

-- CreateIndex
CREATE INDEX "reviews_tenant_id_appraisal_id_idx" ON "reviews"("tenant_id", "appraisal_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_tenant_id_id_key" ON "reviews"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_tenant_id_assignment_id_key" ON "reviews"("tenant_id", "assignment_id");

-- CreateIndex
CREATE INDEX "appraisal_rating_distribution_snapshots_tenant_id_cycle_id__idx" ON "appraisal_rating_distribution_snapshots"("tenant_id", "cycle_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "appraisal_rating_distribution_snapshots_tenant_id_cycle_id__key" ON "appraisal_rating_distribution_snapshots"("tenant_id", "cycle_id", "branch_id", "department_id", "rating_value");

-- AddForeignKey
ALTER TABLE "rating_scales" ADD CONSTRAINT "rating_scales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisal_cycles" ADD CONSTRAINT "appraisal_cycles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisal_cycles" ADD CONSTRAINT "appraisal_cycles_tenant_id_rating_scale_id_fkey" FOREIGN KEY ("tenant_id", "rating_scale_id") REFERENCES "rating_scales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_cycle_id_fkey" FOREIGN KEY ("tenant_id", "cycle_id") REFERENCES "appraisal_cycles"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_parent_goal_id_fkey" FOREIGN KEY ("tenant_id", "parent_goal_id") REFERENCES "goals"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_tenant_id_cycle_id_fkey" FOREIGN KEY ("tenant_id", "cycle_id") REFERENCES "appraisal_cycles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_tenant_id_appraisal_id_fkey" FOREIGN KEY ("tenant_id", "appraisal_id") REFERENCES "appraisals"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_tenant_id_reviewer_id_fkey" FOREIGN KEY ("tenant_id", "reviewer_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "review_assignments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_appraisal_id_fkey" FOREIGN KEY ("tenant_id", "appraisal_id") REFERENCES "appraisals"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_reviewer_id_fkey" FOREIGN KEY ("tenant_id", "reviewer_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisal_rating_distribution_snapshots" ADD CONSTRAINT "appraisal_rating_distribution_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisal_rating_distribution_snapshots" ADD CONSTRAINT "appraisal_rating_distribution_snapshots_tenant_id_branch_i_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
