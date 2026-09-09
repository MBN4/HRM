-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SignatureDocumentSource" AS ENUM ('UPLOADED', 'GENERATED');

-- CreateEnum
CREATE TYPE "SignerType" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('PENDING', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SigningMethod" AS ENUM ('TYPED_NAME', 'DRAWN_SIGNATURE', 'CLICK_TO_SIGN');

-- CreateEnum
CREATE TYPE "SignatureEventType" AS ENUM ('CREATED', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'EXPIRED', 'CERTIFICATE_GENERATED');

-- AlterTable
ALTER TABLE "policies" ADD COLUMN     "requires_signature" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "branch_id" UUID,
    "document_source" "SignatureDocumentSource" NOT NULL,
    "document_storage_key" TEXT NOT NULL,
    "document_mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
    "document_hash" TEXT NOT NULL,
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_signers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "signature_request_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "signer_type" "SignerType" NOT NULL,
    "user_id" UUID,
    "external_name" TEXT,
    "external_email" TEXT,
    "status" "SignerStatus" NOT NULL DEFAULT 'PENDING',
    "access_token_prefix" VARCHAR(16),
    "access_token_hash" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "viewed_at" TIMESTAMP(3),
    "signed_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "signing_method" "SigningMethod",
    "typed_signature_text" TEXT,
    "signature_image_storage_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "signature_request_id" UUID NOT NULL,
    "signer_id" UUID,
    "event_type" "SignatureEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_external_name" TEXT,
    "actor_external_email" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "signing_method" "SigningMethod",
    "document_hash" TEXT,
    "metadata" JSONB,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "signature_request_id" UUID NOT NULL,
    "document_hash" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_requests_tenant_id_status_idx" ON "signature_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "signature_requests_tenant_id_entity_type_entity_id_idx" ON "signature_requests"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_tenant_id_id_key" ON "signature_requests"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "signature_signers_tenant_id_signature_request_id_idx" ON "signature_signers"("tenant_id", "signature_request_id");

-- CreateIndex
CREATE INDEX "signature_signers_tenant_id_user_id_idx" ON "signature_signers"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signers_tenant_id_id_key" ON "signature_signers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signers_tenant_id_access_token_prefix_key" ON "signature_signers"("tenant_id", "access_token_prefix");

-- CreateIndex
CREATE INDEX "signature_events_tenant_id_signature_request_id_idx" ON "signature_events"("tenant_id", "signature_request_id");

-- CreateIndex
CREATE INDEX "signature_events_tenant_id_signer_id_idx" ON "signature_events"("tenant_id", "signer_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_certificates_tenant_id_signature_request_id_key" ON "signature_certificates"("tenant_id", "signature_request_id");

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_tenant_id_signature_request_id_fkey" FOREIGN KEY ("tenant_id", "signature_request_id") REFERENCES "signature_requests"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_tenant_id_signature_request_id_fkey" FOREIGN KEY ("tenant_id", "signature_request_id") REFERENCES "signature_requests"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_tenant_id_signer_id_fkey" FOREIGN KEY ("tenant_id", "signer_id") REFERENCES "signature_signers"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_certificates" ADD CONSTRAINT "signature_certificates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_certificates" ADD CONSTRAINT "signature_certificates_tenant_id_signature_request_id_fkey" FOREIGN KEY ("tenant_id", "signature_request_id") REFERENCES "signature_requests"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
