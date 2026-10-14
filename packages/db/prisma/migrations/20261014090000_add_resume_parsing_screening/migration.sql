-- CreateEnum
CREATE TYPE "ResumeParseStatus" AS ENUM ('NONE', 'PENDING', 'PARSED', 'FAILED');

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "below_threshold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "screened_at" TIMESTAMP(3),
ADD COLUMN     "screening_result" JSONB,
ADD COLUMN     "screening_score" INTEGER;

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "parse_error" TEXT,
ADD COLUMN     "parse_status" "ResumeParseStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "parsed_at" TIMESTAMP(3),
ADD COLUMN     "parsed_data" JSONB,
ADD COLUMN     "parsed_data_edited_at" TIMESTAMP(3),
ADD COLUMN     "parsed_data_edited_by" UUID,
ADD COLUMN     "parser_name" TEXT,
ADD COLUMN     "resume_content_type" TEXT,
ADD COLUMN     "resume_file_name" TEXT;

-- CreateTable
CREATE TABLE "screening_criteria" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screening_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "screening_criteria_tenant_id_requisition_id_key" ON "screening_criteria"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "applications_tenant_id_job_posting_id_screening_score_idx" ON "applications"("tenant_id", "job_posting_id", "screening_score");

-- AddForeignKey
ALTER TABLE "screening_criteria" ADD CONSTRAINT "screening_criteria_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_criteria" ADD CONSTRAINT "screening_criteria_tenant_id_requisition_id_fkey" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "job_requisitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

