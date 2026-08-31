-- CreateEnum
CREATE TYPE "PayrollRunType" AS ENUM ('REGULAR', 'FINAL_SETTLEMENT');

-- CreateEnum
CREATE TYPE "JobRequisitionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobPostingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScorecardRecommendation" AS ENUM ('STRONG_YES', 'YES', 'NO', 'STRONG_NO');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "OnboardingProcessStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OffboardingReason" AS ENUM ('RESIGNATION', 'TERMINATION');

-- CreateEnum
CREATE TYPE "OffboardingProcessStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ChecklistProcessType" AS ENUM ('ONBOARDING', 'OFFBOARDING');

-- CreateEnum
CREATE TYPE "ChecklistTaskStatus" AS ENUM ('PENDING', 'COMPLETED');

-- DropIndex
DROP INDEX "payroll_runs_tenant_id_branch_id_period_year_period_month_key";

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "run_type" "PayrollRunType" NOT NULL DEFAULT 'REGULAR',
ADD COLUMN     "settlement_employee_id" UUID;

-- Two hand-written PARTIAL unique indexes replace the single blanket
-- constraint dropped above — see the PayrollRun model's doc comment in
-- schema.prisma for the full "why" (Postgres treats every NULL as DISTINCT
-- in a unique index, so a single index including the new nullable
-- settlement_employee_id column would have silently weakened the existing
-- REGULAR-run guarantee). Prisma has no partial-index DSL, so — like RLS
-- itself — this is hand-written SQL.
--
-- REGULAR runs: byte-identical to the original constraint.
CREATE UNIQUE INDEX "payroll_runs_regular_unique" ON "payroll_runs"("tenant_id", "branch_id", "period_year", "period_month") WHERE "run_type" = 'REGULAR';

-- FINAL_SETTLEMENT runs: one settlement run per employee per period.
CREATE UNIQUE INDEX "payroll_runs_settlement_unique" ON "payroll_runs"("tenant_id", "settlement_employee_id", "period_year", "period_month") WHERE "run_type" = 'FINAL_SETTLEMENT';

-- CreateTable
CREATE TABLE "job_requisitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "designation_id" UUID,
    "employment_type" "EmploymentType" NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "justification" TEXT,
    "status" "JobRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "public_slug" TEXT NOT NULL,
    "status" "JobPostingStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "resume_storage_key" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "job_posting_id" UUID NOT NULL,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'APPLIED',
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "interviewer_user_ids" JSONB NOT NULL,
    "location" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_scorecards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "interviewer_user_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "recommendation" "ScorecardRecommendation" NOT NULL,
    "notes" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "designation_id" UUID,
    "employment_type" "EmploymentType" NOT NULL,
    "proposed_salary" DECIMAL(14,2) NOT NULL,
    "salary_currency" VARCHAR(3) NOT NULL,
    "proposed_join_date" DATE NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_processes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "employee_id" UUID,
    "status" "OnboardingProcessStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offboarding_processes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reason" "OffboardingReason" NOT NULL,
    "last_working_date" DATE NOT NULL,
    "status" "OffboardingProcessStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflow_instance_id" UUID,
    "settlement_payroll_run_id" UUID,
    "initiated_by_user_id" UUID NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboarding_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_type" "ChecklistProcessType" NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tasks" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_task_instances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_type" "ChecklistProcessType" NOT NULL,
    "process_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "assignee_user_id" UUID,
    "requires_document" BOOLEAN NOT NULL DEFAULT false,
    "document_storage_key" TEXT,
    "status" "ChecklistTaskStatus" NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_task_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_requisitions_tenant_id_status_idx" ON "job_requisitions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "job_requisitions_tenant_id_branch_id_idx" ON "job_requisitions"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_requisitions_tenant_id_id_key" ON "job_requisitions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "job_postings_tenant_id_status_idx" ON "job_postings"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "job_postings_tenant_id_requisition_id_idx" ON "job_postings"("tenant_id", "requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_tenant_id_id_key" ON "job_postings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_tenant_id_public_slug_key" ON "job_postings"("tenant_id", "public_slug");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenant_id_id_key" ON "candidates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenant_id_email_key" ON "candidates"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "applications_tenant_id_job_posting_id_stage_idx" ON "applications"("tenant_id", "job_posting_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenant_id_id_key" ON "applications"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenant_id_candidate_id_job_posting_id_key" ON "applications"("tenant_id", "candidate_id", "job_posting_id");

-- CreateIndex
CREATE INDEX "interviews_tenant_id_application_id_idx" ON "interviews"("tenant_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_tenant_id_id_key" ON "interviews"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_scorecards_tenant_id_id_key" ON "interview_scorecards"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_scorecards_tenant_id_interview_id_interviewer_use_key" ON "interview_scorecards"("tenant_id", "interview_id", "interviewer_user_id");

-- CreateIndex
CREATE INDEX "offers_tenant_id_status_idx" ON "offers"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offers_tenant_id_id_key" ON "offers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_tenant_id_application_id_key" ON "offers"("tenant_id", "application_id");

-- CreateIndex
CREATE INDEX "onboarding_processes_tenant_id_status_idx" ON "onboarding_processes"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_processes_tenant_id_id_key" ON "onboarding_processes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_processes_tenant_id_offer_id_key" ON "onboarding_processes"("tenant_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_processes_tenant_id_employee_id_key" ON "onboarding_processes"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "offboarding_processes_tenant_id_employee_id_idx" ON "offboarding_processes"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "offboarding_processes_tenant_id_status_idx" ON "offboarding_processes"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offboarding_processes_tenant_id_id_key" ON "offboarding_processes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_tenant_id_id_key" ON "checklist_templates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_tenant_id_process_type_name_key" ON "checklist_templates"("tenant_id", "process_type", "name");

-- CreateIndex
CREATE INDEX "checklist_task_instances_tenant_id_assignee_user_id_status_idx" ON "checklist_task_instances"("tenant_id", "assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "checklist_task_instances_tenant_id_process_type_process_id_idx" ON "checklist_task_instances"("tenant_id", "process_type", "process_id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_task_instances_tenant_id_id_key" ON "checklist_task_instances"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_task_instances_tenant_id_process_type_process_id__key" ON "checklist_task_instances"("tenant_id", "process_type", "process_id", "key");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_settlement_employee_id_idx" ON "payroll_runs"("tenant_id", "settlement_employee_id");

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_settlement_employee_id_fkey" FOREIGN KEY ("tenant_id", "settlement_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_tenant_id_designation_id_fkey" FOREIGN KEY ("tenant_id", "designation_id") REFERENCES "designations"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_tenant_id_requisition_id_fkey" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "job_requisitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_candidate_id_fkey" FOREIGN KEY ("tenant_id", "candidate_id") REFERENCES "candidates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_job_posting_id_fkey" FOREIGN KEY ("tenant_id", "job_posting_id") REFERENCES "job_postings"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_application_id_fkey" FOREIGN KEY ("tenant_id", "application_id") REFERENCES "applications"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_tenant_id_interview_id_fkey" FOREIGN KEY ("tenant_id", "interview_id") REFERENCES "interviews"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_application_id_fkey" FOREIGN KEY ("tenant_id", "application_id") REFERENCES "applications"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_designation_id_fkey" FOREIGN KEY ("tenant_id", "designation_id") REFERENCES "designations"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_processes" ADD CONSTRAINT "onboarding_processes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_processes" ADD CONSTRAINT "onboarding_processes_tenant_id_offer_id_fkey" FOREIGN KEY ("tenant_id", "offer_id") REFERENCES "offers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_processes" ADD CONSTRAINT "onboarding_processes_tenant_id_candidate_id_fkey" FOREIGN KEY ("tenant_id", "candidate_id") REFERENCES "candidates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_processes" ADD CONSTRAINT "onboarding_processes_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_processes" ADD CONSTRAINT "offboarding_processes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_processes" ADD CONSTRAINT "offboarding_processes_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_task_instances" ADD CONSTRAINT "checklist_task_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
