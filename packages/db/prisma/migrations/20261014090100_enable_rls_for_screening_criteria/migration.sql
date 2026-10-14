-- `screening_criteria` (step 9.1) is tenant-owned config — ordinary RLS,
-- identical `tenant_isolation` pattern to every other tenant table (see
-- docs/conventions/tenancy-rls.md). The new `candidates`/`applications`
-- columns inherit those tables' existing policies unchanged.
GRANT SELECT, INSERT, UPDATE, DELETE ON "screening_criteria" TO hrm_app;

ALTER TABLE "screening_criteria" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "screening_criteria" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "screening_criteria"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
