-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentItemType" AS ENUM ('VIDEO', 'DOCUMENT', 'LINK');

-- CreateEnum
CREATE TYPE "ContentProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('SELF', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CertificationStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'RENEWED');

-- CreateTable
CREATE TABLE "lms_course_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_course_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_courses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "validity_months" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_course_content_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "module_name" TEXT,
    "order_index" INTEGER NOT NULL,
    "type" "ContentItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "storage_key" TEXT,
    "external_url" TEXT,
    "duration_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_course_content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "source" "EnrollmentSource" NOT NULL DEFAULT 'SELF',
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "enrolled_by_user_id" UUID,
    "due_date" DATE,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_content_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "status" "ContentProgressStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_content_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_quizzes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "pass_mark_percent" INTEGER NOT NULL DEFAULT 70,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_quiz_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "question_text" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correct_option_key" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_quiz_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "score_percent" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "answers" JSONB NOT NULL,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lms_quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_certifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "status" "CertificationStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "renewed_from_certification_id" UUID,
    "last_reminder_bucket" TEXT,
    "last_reminder_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_required_trainings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "role_id" UUID,
    "branch_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lms_required_trainings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_course_completion_daily_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "course_id" UUID NOT NULL,
    "enrolled_count" INTEGER NOT NULL DEFAULT 0,
    "in_progress_count" INTEGER NOT NULL DEFAULT 0,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lms_course_completion_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_training_compliance_daily_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "course_id" UUID NOT NULL,
    "required_count" INTEGER NOT NULL DEFAULT 0,
    "compliant_count" INTEGER NOT NULL DEFAULT 0,
    "expiring_count" INTEGER NOT NULL DEFAULT 0,
    "expired_count" INTEGER NOT NULL DEFAULT 0,
    "missing_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lms_training_compliance_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lms_course_categories_tenant_id_id_key" ON "lms_course_categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_course_categories_tenant_id_code_key" ON "lms_course_categories"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "lms_courses_tenant_id_status_idx" ON "lms_courses"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "lms_courses_tenant_id_category_id_idx" ON "lms_courses"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_courses_tenant_id_id_key" ON "lms_courses"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_course_content_items_tenant_id_course_id_order_index_idx" ON "lms_course_content_items"("tenant_id", "course_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "lms_course_content_items_tenant_id_id_key" ON "lms_course_content_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_enrollments_tenant_id_employee_id_status_idx" ON "lms_enrollments"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "lms_enrollments_tenant_id_course_id_idx" ON "lms_enrollments"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "lms_enrollments_tenant_id_due_date_idx" ON "lms_enrollments"("tenant_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "lms_enrollments_tenant_id_id_key" ON "lms_enrollments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_enrollments_tenant_id_course_id_employee_id_key" ON "lms_enrollments"("tenant_id", "course_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_content_progress_tenant_id_id_key" ON "lms_content_progress"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_content_progress_tenant_id_enrollment_id_content_item_i_key" ON "lms_content_progress"("tenant_id", "enrollment_id", "content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_quizzes_tenant_id_id_key" ON "lms_quizzes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_quizzes_tenant_id_course_id_key" ON "lms_quizzes"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "lms_quiz_questions_tenant_id_quiz_id_order_index_idx" ON "lms_quiz_questions"("tenant_id", "quiz_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "lms_quiz_questions_tenant_id_id_key" ON "lms_quiz_questions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_quiz_attempts_tenant_id_enrollment_id_idx" ON "lms_quiz_attempts"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "lms_quiz_attempts_tenant_id_quiz_id_employee_id_idx" ON "lms_quiz_attempts"("tenant_id", "quiz_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_quiz_attempts_tenant_id_id_key" ON "lms_quiz_attempts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_certifications_tenant_id_employee_id_status_idx" ON "lms_certifications"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "lms_certifications_tenant_id_course_id_status_idx" ON "lms_certifications"("tenant_id", "course_id", "status");

-- CreateIndex
CREATE INDEX "lms_certifications_tenant_id_status_expires_at_idx" ON "lms_certifications"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "lms_certifications_tenant_id_id_key" ON "lms_certifications"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_required_trainings_tenant_id_course_id_idx" ON "lms_required_trainings"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "lms_required_trainings_tenant_id_role_id_idx" ON "lms_required_trainings"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "lms_required_trainings_tenant_id_branch_id_idx" ON "lms_required_trainings"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_required_trainings_tenant_id_id_key" ON "lms_required_trainings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lms_course_completion_daily_snapshots_tenant_id_snapshot_da_idx" ON "lms_course_completion_daily_snapshots"("tenant_id", "snapshot_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_course_completion_daily_snapshots_tenant_id_snapshot_da_key" ON "lms_course_completion_daily_snapshots"("tenant_id", "snapshot_date", "branch_id", "department_id", "course_id");

-- CreateIndex
CREATE INDEX "lms_training_compliance_daily_snapshots_tenant_id_snapshot__idx" ON "lms_training_compliance_daily_snapshots"("tenant_id", "snapshot_date", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lms_training_compliance_daily_snapshots_tenant_id_snapshot__key" ON "lms_training_compliance_daily_snapshots"("tenant_id", "snapshot_date", "branch_id", "department_id", "course_id");

-- AddForeignKey
ALTER TABLE "lms_course_categories" ADD CONSTRAINT "lms_course_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_courses" ADD CONSTRAINT "lms_courses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_courses" ADD CONSTRAINT "lms_courses_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "lms_course_categories"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_course_content_items" ADD CONSTRAINT "lms_course_content_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_course_content_items" ADD CONSTRAINT "lms_course_content_items_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_content_progress" ADD CONSTRAINT "lms_content_progress_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_content_progress" ADD CONSTRAINT "lms_content_progress_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "lms_enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_content_progress" ADD CONSTRAINT "lms_content_progress_tenant_id_content_item_id_fkey" FOREIGN KEY ("tenant_id", "content_item_id") REFERENCES "lms_course_content_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quizzes" ADD CONSTRAINT "lms_quizzes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quizzes" ADD CONSTRAINT "lms_quizzes_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_questions" ADD CONSTRAINT "lms_quiz_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_questions" ADD CONSTRAINT "lms_quiz_questions_tenant_id_quiz_id_fkey" FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "lms_quizzes"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_attempts" ADD CONSTRAINT "lms_quiz_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_attempts" ADD CONSTRAINT "lms_quiz_attempts_tenant_id_quiz_id_fkey" FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "lms_quizzes"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_attempts" ADD CONSTRAINT "lms_quiz_attempts_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "lms_enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_quiz_attempts" ADD CONSTRAINT "lms_quiz_attempts_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_certifications" ADD CONSTRAINT "lms_certifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_certifications" ADD CONSTRAINT "lms_certifications_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_certifications" ADD CONSTRAINT "lms_certifications_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_certifications" ADD CONSTRAINT "lms_certifications_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "lms_enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_certifications" ADD CONSTRAINT "lms_certifications_tenant_id_renewed_from_certification_id_fkey" FOREIGN KEY ("tenant_id", "renewed_from_certification_id") REFERENCES "lms_certifications"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_required_trainings" ADD CONSTRAINT "lms_required_trainings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_required_trainings" ADD CONSTRAINT "lms_required_trainings_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_required_trainings" ADD CONSTRAINT "lms_required_trainings_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_required_trainings" ADD CONSTRAINT "lms_required_trainings_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_course_completion_daily_snapshots" ADD CONSTRAINT "lms_course_completion_daily_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_course_completion_daily_snapshots" ADD CONSTRAINT "lms_course_completion_daily_snapshots_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_course_completion_daily_snapshots" ADD CONSTRAINT "lms_course_completion_daily_snapshots_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_training_compliance_daily_snapshots" ADD CONSTRAINT "lms_training_compliance_daily_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_training_compliance_daily_snapshots" ADD CONSTRAINT "lms_training_compliance_daily_snapshots_tenant_id_branch_i_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lms_training_compliance_daily_snapshots" ADD CONSTRAINT "lms_training_compliance_daily_snapshots_tenant_id_course_i_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "lms_courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
