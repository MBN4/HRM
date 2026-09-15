-- Data privacy & residency (step 6.1) — see
-- docs/conventions/privacy-residency.md.
--
-- `data_subject_requests`, `consent_records`, and
-- `tenant_data_retention_overrides` are ordinary tenant-scoped tables —
-- identical `tenant_isolation` policy pattern to every other tenant-owned
-- table in this schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_subject_requests" TO hrm_app;
ALTER TABLE "data_subject_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_subject_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_subject_requests"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "consent_records" TO hrm_app;
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consent_records"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_data_retention_overrides" TO hrm_app;
ALTER TABLE "tenant_data_retention_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_data_retention_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_data_retention_overrides"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- `data_processing_register`/`sub_processor_records`/`data_retention_policies`
-- are global, platform-owned reference/catalog data with no `tenant_id`
-- column for a policy to filter on — the SAME exemption `country_packs`
-- already establishes for itself (see the `enable_rls_for_country_overrides`
-- migration). `hrm_app` gets SELECT ONLY: every TENANT request reads these
-- three live (the processing register, sub-processor disclosure, and
-- effective retention policy are all shown on the tenant portal's own
-- `/privacy` page), but writing/authoring them is a vendor/platform
-- operation via `@PlatformRoute()` (`PRIVACY_MANAGE`) through the OWNER
-- `prisma` client only — no INSERT/UPDATE/DELETE grant to `hrm_app` at all.
GRANT SELECT ON "data_processing_register" TO hrm_app;
GRANT SELECT ON "sub_processor_records" TO hrm_app;
GRANT SELECT ON "data_retention_policies" TO hrm_app;
