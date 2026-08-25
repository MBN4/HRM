-- CreateTable
CREATE TABLE "country_packs" (
    "id" UUID NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_country_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "overrides" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_country_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "country_packs_country_code_is_active_idx" ON "country_packs"("country_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "country_packs_country_code_version_key" ON "country_packs"("country_code", "version");

-- CreateIndex
CREATE INDEX "tenant_country_overrides_tenant_id_idx" ON "tenant_country_overrides"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_country_overrides_tenant_id_country_code_key" ON "tenant_country_overrides"("tenant_id", "country_code");

-- AddForeignKey
ALTER TABLE "tenant_country_overrides" ADD CONSTRAINT "tenant_country_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
