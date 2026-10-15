-- CreateEnum
CREATE TYPE "RecognitionVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyAudienceType" AS ENUM ('ORG', 'BRANCH', 'DEPARTMENT', 'TEAM');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('RATING', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT');

-- CreateEnum
CREATE TYPE "SurveyAssignmentStatus" AS ENUM ('PENDING', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "FeedPostType" AS ENUM ('RECOGNITION', 'ANNOUNCEMENT', 'CELEBRATION');

-- CreateEnum
CREATE TYPE "FeedScopeType" AS ENUM ('ORG', 'BRANCH', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "CelebrationKind" AS ENUM ('BIRTHDAY', 'WORK_ANNIVERSARY', 'NEW_JOINER');

-- CreateEnum
CREATE TYPE "FeedReactionType" AS ENUM ('LIKE', 'CELEBRATE');

-- CreateTable
CREATE TABLE "recognition_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "points" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recognition_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recognitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "giver_employee_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "visibility" "RecognitionVisibility" NOT NULL DEFAULT 'PUBLIC',
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recognitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recognition_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recognition_id" UUID NOT NULL,
    "recipient_employee_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "recognition_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recognition_balances" (
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "received_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recognition_balances_pkey" PRIMARY KEY ("tenant_id","employee_id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "audience_type" "SurveyAudienceType" NOT NULL DEFAULT 'ORG',
    "audience_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "opens_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "assigned_count" INTEGER NOT NULL DEFAULT 0,
    "response_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "scale_min" INTEGER,
    "scale_max" INTEGER,
    "options" JSONB,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "SurveyAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "respondent_user_id" UUID,
    "submitted_on" DATE NOT NULL,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_answers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "rating_value" INTEGER,
    "option_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text_value" TEXT,

    CONSTRAINT "survey_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_tallies" (
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "survey_tallies_pkey" PRIMARY KEY ("survey_id","question_id","bucket")
);

-- CreateTable
CREATE TABLE "feed_posts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "FeedPostType" NOT NULL,
    "scope_type" "FeedScopeType" NOT NULL DEFAULT 'ORG',
    "scope_id" UUID,
    "author_user_id" UUID,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "recognition_id" UUID,
    "celebration_kind" "CelebrationKind",
    "subject_employee_id" UUID,
    "celebration_key" TEXT,
    "meta" JSONB,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" UUID,
    "removal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_reactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "FeedReactionType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recognition_categories_tenant_id_id_key" ON "recognition_categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recognition_categories_tenant_id_name_key" ON "recognition_categories"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "recognitions_tenant_id_created_at_idx" ON "recognitions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "recognitions_tenant_id_giver_employee_id_idx" ON "recognitions"("tenant_id", "giver_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "recognitions_tenant_id_id_key" ON "recognitions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "recognition_recipients_tenant_id_recipient_employee_id_occu_idx" ON "recognition_recipients"("tenant_id", "recipient_employee_id", "occurred_at");

-- CreateIndex
CREATE INDEX "recognition_recipients_tenant_id_occurred_at_idx" ON "recognition_recipients"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "recognition_recipients_recognition_id_recipient_employee_id_key" ON "recognition_recipients"("recognition_id", "recipient_employee_id");

-- CreateIndex
CREATE INDEX "recognition_balances_tenant_id_total_points_idx" ON "recognition_balances"("tenant_id", "total_points");

-- CreateIndex
CREATE INDEX "surveys_tenant_id_status_idx" ON "surveys"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "surveys_tenant_id_id_key" ON "surveys"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_questions_tenant_id_id_key" ON "survey_questions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_questions_survey_id_order_key" ON "survey_questions"("survey_id", "order");

-- CreateIndex
CREATE INDEX "survey_assignments_tenant_id_user_id_status_idx" ON "survey_assignments"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "survey_assignments_survey_id_user_id_key" ON "survey_assignments"("survey_id", "user_id");

-- CreateIndex
CREATE INDEX "survey_responses_tenant_id_survey_id_idx" ON "survey_responses"("tenant_id", "survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_responses_tenant_id_id_key" ON "survey_responses"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "survey_answers_tenant_id_survey_id_question_id_idx" ON "survey_answers"("tenant_id", "survey_id", "question_id");

-- CreateIndex
CREATE INDEX "survey_tallies_tenant_id_survey_id_idx" ON "survey_tallies"("tenant_id", "survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "feed_posts_recognition_id_key" ON "feed_posts"("recognition_id");

-- CreateIndex
CREATE INDEX "feed_posts_tenant_id_removed_at_created_at_idx" ON "feed_posts"("tenant_id", "removed_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feed_posts_tenant_id_id_key" ON "feed_posts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "feed_posts_tenant_id_celebration_key_key" ON "feed_posts"("tenant_id", "celebration_key");

-- CreateIndex
CREATE INDEX "feed_reactions_tenant_id_post_id_idx" ON "feed_reactions"("tenant_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "feed_reactions_post_id_user_id_key" ON "feed_reactions"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "feed_comments_tenant_id_post_id_created_at_idx" ON "feed_comments"("tenant_id", "post_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feed_comments_tenant_id_id_key" ON "feed_comments"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "recognition_categories" ADD CONSTRAINT "recognition_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_tenant_id_giver_employee_id_fkey" FOREIGN KEY ("tenant_id", "giver_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "recognition_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_recipients" ADD CONSTRAINT "recognition_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_recipients" ADD CONSTRAINT "recognition_recipients_tenant_id_recognition_id_fkey" FOREIGN KEY ("tenant_id", "recognition_id") REFERENCES "recognitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_recipients" ADD CONSTRAINT "recognition_recipients_tenant_id_recipient_employee_id_fkey" FOREIGN KEY ("tenant_id", "recipient_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_balances" ADD CONSTRAINT "recognition_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_balances" ADD CONSTRAINT "recognition_balances_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_tenant_id_survey_id_fkey" FOREIGN KEY ("tenant_id", "survey_id") REFERENCES "surveys"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_assignments" ADD CONSTRAINT "survey_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_assignments" ADD CONSTRAINT "survey_assignments_tenant_id_survey_id_fkey" FOREIGN KEY ("tenant_id", "survey_id") REFERENCES "surveys"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_tenant_id_survey_id_fkey" FOREIGN KEY ("tenant_id", "survey_id") REFERENCES "surveys"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_tenant_id_response_id_fkey" FOREIGN KEY ("tenant_id", "response_id") REFERENCES "survey_responses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_tallies" ADD CONSTRAINT "survey_tallies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_tenant_id_subject_employee_id_fkey" FOREIGN KEY ("tenant_id", "subject_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_tenant_id_post_id_fkey" FOREIGN KEY ("tenant_id", "post_id") REFERENCES "feed_posts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_comments" ADD CONSTRAINT "feed_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_comments" ADD CONSTRAINT "feed_comments_tenant_id_post_id_fkey" FOREIGN KEY ("tenant_id", "post_id") REFERENCES "feed_posts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

