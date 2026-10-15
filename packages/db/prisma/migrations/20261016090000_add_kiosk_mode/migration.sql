-- Step 11.1 (kiosk mode) — additive. See docs/conventions/kiosk.md.
-- CreateEnum
CREATE TYPE "KioskStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'KIOSK';

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "clock_in_kiosk_id" UUID,
ADD COLUMN     "clock_out_kiosk_id" UUID;

-- CreateTable
CREATE TABLE "kiosks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_prefix" VARCHAR(20) NOT NULL,
    "hashed_token" TEXT NOT NULL,
    "status" "KioskStatus" NOT NULL DEFAULT 'ACTIVE',
    "require_photo" BOOLEAN NOT NULL DEFAULT false,
    "biometric_enabled" BOOLEAN NOT NULL DEFAULT false,
    "token_issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kiosks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_kiosk_pins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "issued_by_user_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "employee_kiosk_pins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kiosks_token_prefix_key" ON "kiosks"("token_prefix");

-- CreateIndex
CREATE INDEX "kiosks_tenant_id_branch_id_idx" ON "kiosks"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "kiosks_tenant_id_id_key" ON "kiosks"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "employee_kiosk_pins_tenant_id_idx" ON "employee_kiosk_pins"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_kiosk_pins_tenant_id_employee_id_key" ON "employee_kiosk_pins"("tenant_id", "employee_id");

-- AddForeignKey
ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_kiosk_pins" ADD CONSTRAINT "employee_kiosk_pins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_kiosk_pins" ADD CONSTRAINT "employee_kiosk_pins_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

