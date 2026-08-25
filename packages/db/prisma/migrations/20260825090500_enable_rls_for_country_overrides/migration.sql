-- `country_packs` is exempt from Row-Level Security, same as `tenants`/
-- `tenant_domains` (see the comment on the CountryPack model in
-- schema.prisma): it is global, system-owned reference data with no
-- `tenant_id` column for a policy to filter on — every tenant's branches
-- resolve against the SAME pack rows. No ENABLE/FORCE ROW LEVEL SECURITY
-- and no policy here — that is deliberate, not an oversight.
--
-- Only SELECT is granted: writing/activating packs is an admin/platform
-- operation that doesn't have a real write path yet (lands with the vendor
-- admin console, same as `tenant_domains`); today packs are only written by
-- the owner/migration role via `packages/db/src/seed-country-packs.ts`.
GRANT SELECT ON "country_packs" TO hrm_app;

-- `tenant_country_overrides` IS tenant-scoped — ordinary RLS applies,
-- identical pattern to every other tenant-owned table in this schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_country_overrides" TO hrm_app;

ALTER TABLE "tenant_country_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_country_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tenant_country_overrides"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
