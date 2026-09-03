-- AddUniqueConstraint
CREATE UNIQUE INDEX "api_keys_tenant_id_id_key" ON "api_keys"("tenant_id", "id");
