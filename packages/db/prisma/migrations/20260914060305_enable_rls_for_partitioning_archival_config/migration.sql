-- Partitioning + archival config (step 5.2) — see
-- docs/conventions/partitioning-archival.md.
--
-- `tenant_retention_overrides` is an ordinary tenant-scoped table —
-- identical `tenant_isolation` policy pattern to every other tenant-owned
-- table in this schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_retention_overrides" TO hrm_app;

ALTER TABLE "tenant_retention_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_retention_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tenant_retention_overrides"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- `partitioned_table_configs`/`archived_partitions` are DELIBERATELY given NO
-- grant to `hrm_app` at all — the SAME exemption `platform_admins`/
-- `platform_audit_log` already establish (see the
-- `add_platform_vendor_console` migration): both are platform-wide infra
-- metadata with no `tenant_id` to filter on, read/written exclusively by
-- `PartitionMaintenanceService`/`PartitionArchivalService`/the platform
-- controller through the OWNER `prisma` client (a `@PlatformRoute()` request
-- opens no tenant-scoped transaction at all — see
-- docs/conventions/tenant-resolution.md § Platform context). No RLS policy
-- is needed either, for the same reason `Tenant`/`CountryPack` have none.
