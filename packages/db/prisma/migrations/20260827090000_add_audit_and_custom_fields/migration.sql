-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('STRING', 'NUMBER', 'DATE', 'BOOLEAN', 'ENUM');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_platform" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","occurred_at")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" "CustomFieldType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_value_sets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_value_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_actor_user_id_idx" ON "audit_log"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "custom_field_definitions_tenant_id_entity_type_idx" ON "custom_field_definitions"("tenant_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_tenant_id_id_key" ON "custom_field_definitions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_tenant_id_entity_type_field_key_key" ON "custom_field_definitions"("tenant_id", "entity_type", "field_key");

-- CreateIndex
CREATE INDEX "custom_field_value_sets_tenant_id_entity_type_idx" ON "custom_field_value_sets"("tenant_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_sets_tenant_id_entity_type_entity_id_key" ON "custom_field_value_sets"("tenant_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value_sets" ADD CONSTRAINT "custom_field_value_sets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

