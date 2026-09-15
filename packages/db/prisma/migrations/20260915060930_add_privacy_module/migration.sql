-- CreateEnum
CREATE TYPE "DataSubjectType" AS ENUM ('EMPLOYEE', 'CANDIDATE', 'USER');

-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('EXPORT', 'ERASURE');

-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DataCategory" AS ENUM ('EMPLOYEE_PROFILE', 'EMPLOYEE_POST_EXIT', 'CANDIDATE_RECORDS', 'PAYROLL_TAX_RECORDS', 'AUDIT_TRAIL', 'DOCUMENTS');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('HARD_DELETE', 'ANONYMIZE', 'RETAIN_LEGAL');

-- CreateTable
CREATE TABLE "data_subject_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_type" "PrivacyRequestType" NOT NULL,
    "subject_type" "DataSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requested_by_user_id" UUID,
    "initiated_by_platform_admin_id" UUID,
    "system_initiated" BOOLEAN NOT NULL DEFAULT false,
    "result_storage_key" TEXT,
    "erasure_summary" JSONB,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" "DataSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "recorded_by_user_id" UUID,
    "granted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_processing_register" (
    "category" "DataCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "purpose_of_processing" TEXT NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "data_subject_types" "DataSubjectType"[],
    "source_modules" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_processing_register_pkey" PRIMARY KEY ("category")
);

-- CreateTable
CREATE TABLE "sub_processor_records" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "data_categories" "DataCategory"[],
    "region" TEXT NOT NULL,
    "contract_reference" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_processor_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_policies" (
    "category" "DataCategory" NOT NULL,
    "retention_months" INTEGER NOT NULL,
    "action" "RetentionAction" NOT NULL,
    "legal_basis_note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("category")
);

-- CreateTable
CREATE TABLE "tenant_data_retention_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" "DataCategory" NOT NULL,
    "retention_months" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_data_retention_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_subject_requests_tenant_id_status_idx" ON "data_subject_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "data_subject_requests_tenant_id_subject_type_subject_id_idx" ON "data_subject_requests"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "consent_records_tenant_id_subject_type_subject_id_idx" ON "consent_records"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "sub_processor_records_name_key" ON "sub_processor_records"("name");

-- CreateIndex
CREATE INDEX "tenant_data_retention_overrides_tenant_id_idx" ON "tenant_data_retention_overrides"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_data_retention_overrides_tenant_id_category_key" ON "tenant_data_retention_overrides"("tenant_id", "category");

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_data_retention_overrides" ADD CONSTRAINT "tenant_data_retention_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the platform-default retention/erasure-action per DataCategory —
-- the SAME "sane defaults from the moment this migration runs" posture
-- `add_partitioning_archival_config`'s own seed already establishes for
-- PartitionedTableConfig. Every number/action here is an ILLUSTRATIVE
-- default (the same "not a certified figure, a real platform admin tunes
-- this via PUT /platform/privacy/retention-policies/:category" posture
-- BILLING_PLANS/seed-country-packs.ts/PartitionedTableConfig already
-- document for their own numbers) — see docs/conventions/privacy-residency.md
-- for the full erasure-policy-per-category write-up.
INSERT INTO "data_retention_policies" ("category", "retention_months", "action", "legal_basis_note", "updated_at") VALUES
  ('EMPLOYEE_PROFILE', 0, 'RETAIN_LEGAL', 'Active employment relationship — required for payroll/legal HR obligations. Not subject to automatic retention purge; erasure of this category is only ever a direct, on-demand request against a TERMINATED employee.', CURRENT_TIMESTAMP),
  ('EMPLOYEE_POST_EXIT', 84, 'ANONYMIZE', 'Illustrative default aligned with a common 7-year statutory wage/tax record-keeping window (the SAME baseline this codebase''s own AUDIT_LOG/PLATFORM_AUDIT_LOG PartitionedTableConfig rows already use) — VERIFY against each operating jurisdiction''s own labor/tax law before relying on it for a real employee.', CURRENT_TIMESTAMP),
  ('CANDIDATE_RECORDS', 12, 'HARD_DELETE', 'Unsuccessful/withdrawn candidates have no ongoing employment relationship — a short illustrative window is kept for a potential discrimination-claim defense before hard deletion. VERIFY the appropriate window locally.', CURRENT_TIMESTAMP),
  ('PAYROLL_TAX_RECORDS', 84, 'RETAIN_LEGAL', 'Statutory payroll/tax record-keeping (see docs/conventions/payroll.md). PayrollRunLine/PayslipDocument carry no direct PII of their own (amounts plus an Employee foreign key only) — once the linked Employee row is anonymized, this category needs no separate action.', CURRENT_TIMESTAMP),
  ('AUDIT_TRAIL', 84, 'RETAIN_LEGAL', 'Bulk retention/archival of audit_log as a WHOLE is governed by Phase 5.2''s own PartitionedTableConfig (AUDIT_LOG) — this row exists so the processing register/retention-policy READ surface has a complete catalog. A specific data subject''s PII inside audit_log is instead anonymized-WITHIN immediately upon an approved erasure request (never row-deleted, never bulk-purged by the retention job) — see docs/conventions/privacy-residency.md.', CURRENT_TIMESTAMP),
  ('DOCUMENTS', 84, 'HARD_DELETE', 'Uploaded employee documents are hard-deleted (metadata row and object-storage bytes) once the owning employee''s own EMPLOYEE_POST_EXIT window lapses, unless a specific document is separately known to require longer legal retention.', CURRENT_TIMESTAMP)
ON CONFLICT ("category") DO NOTHING;

-- Seed the Record of Processing Activities (ROPA) — one catalog row per
-- DataCategory, authored by the vendor, read live by every tenant (see the
-- matching enable-RLS migration's GRANT). Illustrative, not a certified
-- legal filing — the same honest-boundary framing this codebase already
-- takes for the Pakistan country pack's own VERIFY-flagged figures.
INSERT INTO "data_processing_register" ("category", "description", "purpose_of_processing", "legal_basis", "data_subject_types", "source_modules", "updated_at") VALUES
  ('EMPLOYEE_PROFILE', 'Core employee identity, job, and contact data.', 'Employment administration, payroll, statutory compliance, and internal HR operations.', 'Performance of the employment contract; compliance with legal obligations.', ARRAY['EMPLOYEE']::"DataSubjectType"[], ARRAY['employees','leave','attendance','performance','benefits'], CURRENT_TIMESTAMP),
  ('EMPLOYEE_POST_EXIT', 'Former-employee identity/contact data retained after termination.', 'Statutory wage/tax record-keeping and defense of potential post-employment legal claims.', 'Legal obligation; legitimate interest.', ARRAY['EMPLOYEE']::"DataSubjectType"[], ARRAY['employees','offboarding','payroll'], CURRENT_TIMESTAMP),
  ('CANDIDATE_RECORDS', 'Recruitment pipeline data for job applicants.', 'Evaluating candidates for employment.', 'Consent; legitimate interest (recruitment).', ARRAY['CANDIDATE']::"DataSubjectType"[], ARRAY['recruitment'], CURRENT_TIMESTAMP),
  ('PAYROLL_TAX_RECORDS', 'Computed payroll amounts, payslips, and statutory filings.', 'Wage payment and statutory tax/social-insurance reporting.', 'Legal obligation.', ARRAY['EMPLOYEE']::"DataSubjectType"[], ARRAY['payroll','statutory-reporting','benefits'], CURRENT_TIMESTAMP),
  ('AUDIT_TRAIL', 'Immutable system-wide record of mutating actions.', 'Security, accountability, and dispute resolution.', 'Legal obligation; legitimate interest.', ARRAY['EMPLOYEE','CANDIDATE','USER']::"DataSubjectType"[], ARRAY['audit'], CURRENT_TIMESTAMP),
  ('DOCUMENTS', 'Uploaded HR documents (contracts, identification, certificates).', 'Employment administration and statutory compliance.', 'Performance of the employment contract; legal obligation.', ARRAY['EMPLOYEE']::"DataSubjectType"[], ARRAY['employees'], CURRENT_TIMESTAMP)
ON CONFLICT ("category") DO NOTHING;

-- Seed the vendor's own sub-processor disclosure — illustrative entries
-- naming the REAL adapter seams this codebase already has (S3/MinIO
-- storage since 1.1, Stripe since 4.2, the email provider seam since 0.8),
-- not a legally reviewed list for any specific deployment.
INSERT INTO "sub_processor_records" ("id", "name", "purpose", "data_categories", "region", "contract_reference", "added_at", "updated_at") VALUES
  (gen_random_uuid(), 'Object storage (S3-compatible)', 'Stores uploaded HR documents, generated PDFs (payslips, certificates, statutory reports), and data-subject export bundles.', ARRAY['DOCUMENTS','PAYROLL_TAX_RECORDS']::"DataCategory"[], 'Same region as the tenant''s own deployment — see docs/conventions/deployment-scaling.md.', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Stripe', 'SaaS subscription billing and payment processing (SaaS-mode tenants only) — see docs/conventions/billing.md.', ARRAY[]::"DataCategory"[], 'Global (Stripe-operated).', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Transactional email provider', 'Delivers notification/reminder emails via the EMAIL_PROVIDER adapter seam — see docs/conventions/notifications-queues.md.', ARRAY['EMPLOYEE_PROFILE']::"DataCategory"[], 'Configurable per deployment.', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Sentry', 'Error tracking and diagnostics — PII is redacted before capture (sendDefaultPii: false) — see docs/conventions/observability-load.md.', ARRAY[]::"DataCategory"[], 'Configurable per deployment.', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
