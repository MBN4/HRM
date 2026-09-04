/*
  Warnings:

  - Added the required column `verification_token` to the `tenant_domains` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DomainVerificationStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "DomainCertStatus" AS ENUM ('NONE', 'PENDING', 'ISSUED', 'FAILED');

-- AlterTable
ALTER TABLE "tenant_domains" ADD COLUMN     "cert_expires_at" TIMESTAMP(3),
ADD COLUMN     "cert_provisioned_at" TIMESTAMP(3),
ADD COLUMN     "cert_status" "DomainCertStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "requested_by_user_id" UUID,
ADD COLUMN     "verification_status" "DomainVerificationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
-- No `@default` in schema.prisma (the app always supplies an explicit
-- random token on insert) — this DEFAULT exists only to backfill any
-- pre-existing row from before this column existed, without depending on
-- the pgcrypto extension.
ADD COLUMN     "verification_token" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text);

ALTER TABLE "tenant_domains" ALTER COLUMN "verification_token" DROP DEFAULT;

-- CreateTable
CREATE TABLE "tenant_brandings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_name" TEXT,
    "logo_storage_key" TEXT,
    "favicon_storage_key" TEXT,
    "primary_color" VARCHAR(7),
    "secondary_color" VARCHAR(7),
    "accent_color" VARCHAR(7),
    "login_headline" TEXT,
    "login_subtext" TEXT,
    "email_from_name" TEXT,
    "email_from_address" TEXT,
    "full_rebrand_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_brandings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_brandings_tenant_id_key" ON "tenant_brandings"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_brandings" ADD CONSTRAINT "tenant_brandings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
