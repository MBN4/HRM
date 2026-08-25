-- Licensing (step 0.6). All three tables carry a `tenant_id` and are
-- ordinary tenant-scoped data — unlike CountryPack (0.5), there is no
-- "must resolve before a tenant context exists" reason to exempt any of
-- them from Row-Level Security. The identical `tenant_isolation` policy
-- pattern applies to all three.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "subscriptions",
  "licenses",
  "tenant_feature_flag_overrides"
  TO hrm_app;

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "licenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "licenses" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_feature_flag_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_feature_flag_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "subscriptions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "licenses"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "tenant_feature_flag_overrides"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
