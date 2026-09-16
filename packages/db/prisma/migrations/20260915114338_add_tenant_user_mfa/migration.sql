-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_recovery_codes_hashed" JSONB,
ADD COLUMN     "mfa_secret_encrypted" TEXT;
