-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "legal_entity_id" UUID;

-- AlterTable
ALTER TABLE "generated_reports" ADD COLUMN     "legal_entity_id" UUID;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "legal_entity_id" UUID;

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "registration_number" TEXT,
    "tax_id" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "logo_storage_key" TEXT,
    "bank_name_encrypted" TEXT,
    "bank_account_number_encrypted" TEXT,
    "bank_routing_code_encrypted" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_entities_tenant_id_idx" ON "legal_entities"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entities_tenant_id_id_key" ON "legal_entities"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_legal_entity_id_fkey" FOREIGN KEY ("tenant_id", "legal_entity_id") REFERENCES "legal_entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_legal_entity_id_fkey" FOREIGN KEY ("tenant_id", "legal_entity_id") REFERENCES "legal_entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_reports" ADD CONSTRAINT "generated_reports_tenant_id_legal_entity_id_fkey" FOREIGN KEY ("tenant_id", "legal_entity_id") REFERENCES "legal_entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
