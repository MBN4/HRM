-- Every Performance module table (step 2.2) IS tenant-scoped — ordinary RLS
-- applies, identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
-- Unlike Payroll's `exchange_rates`, there is no RLS-exempt table in this
-- step — a rating scale/cycle is tenant-authored configuration, not global
-- reference data.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "rating_scales",
  "appraisal_cycles",
  "goals",
  "appraisals",
  "review_assignments",
  "reviews",
  "appraisal_rating_distribution_snapshots"
  TO hrm_app;

ALTER TABLE "rating_scales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rating_scales" FORCE ROW LEVEL SECURITY;

ALTER TABLE "appraisal_cycles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appraisal_cycles" FORCE ROW LEVEL SECURITY;

ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;

ALTER TABLE "appraisals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appraisals" FORCE ROW LEVEL SECURITY;

ALTER TABLE "review_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_assignments" FORCE ROW LEVEL SECURITY;

ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" FORCE ROW LEVEL SECURITY;

ALTER TABLE "appraisal_rating_distribution_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appraisal_rating_distribution_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "rating_scales"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "appraisal_cycles"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "goals"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "appraisals"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "review_assignments"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "reviews"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "appraisal_rating_distribution_snapshots"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
