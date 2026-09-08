-- Every Benefits Administration table (step 3.5.2) IS tenant-scoped —
-- ordinary RLS applies, identical `tenant_isolation` policy pattern to
-- every other tenant-owned table in this schema (see
-- docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "benefit_plans",
  "benefit_plan_tiers",
  "benefit_enrollments",
  "benefit_enrollment_dependents",
  "benefit_contribution_records"
  TO hrm_app;

ALTER TABLE "benefit_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefit_plans" FORCE ROW LEVEL SECURITY;

ALTER TABLE "benefit_plan_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefit_plan_tiers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "benefit_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefit_enrollments" FORCE ROW LEVEL SECURITY;

ALTER TABLE "benefit_enrollment_dependents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefit_enrollment_dependents" FORCE ROW LEVEL SECURITY;

ALTER TABLE "benefit_contribution_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefit_contribution_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "benefit_plans"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "benefit_plan_tiers"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "benefit_enrollments"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "benefit_enrollment_dependents"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "benefit_contribution_records"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
