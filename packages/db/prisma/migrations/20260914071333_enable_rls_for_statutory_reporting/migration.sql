-- Statutory / government reporting (step 3.5.4) — see
-- docs/conventions/statutory-reporting.md.
--
-- `statutory_report_definitions` is exempt from Row-Level Security, same as
-- `country_packs` (see the comment on the CountryPack model in
-- schema.prisma): it is global, system-owned reference data (a REPORT
-- CATALOG, not tenant data) with no `tenant_id` column for a policy to
-- filter on — every tenant resolves against the SAME definition rows for a
-- given country. No ENABLE/FORCE ROW LEVEL SECURITY and no policy here —
-- deliberate, not an oversight.
--
-- Only SELECT is granted: authoring a report definition is an admin/seeding
-- operation today (a real admin-editable UI is later work, the same
-- "not yet built" posture `country_packs` already documents), writable only
-- via the owner/migration role through
-- `packages/db/src/seed-statutory-report-definitions.ts`.
GRANT SELECT ON "statutory_report_definitions" TO hrm_app;

-- `generated_reports` IS tenant-scoped — ordinary RLS applies, identical
-- `tenant_isolation` policy pattern to every other tenant-owned table in
-- this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON "generated_reports" TO hrm_app;

ALTER TABLE "generated_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generated_reports" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "generated_reports"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
