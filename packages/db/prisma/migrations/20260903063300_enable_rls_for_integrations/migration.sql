-- Every Integrations table (step 3.3) IS tenant-scoped — ordinary RLS
-- applies, identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "webhook_subscriptions", "webhook_deliveries", "api_keys", "sso_configs",
  "biometric_device_registrations", "slack_workspace_configs"
  TO hrm_app;

ALTER TABLE "webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscriptions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sso_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sso_configs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "biometric_device_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biometric_device_registrations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_workspace_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_workspace_configs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "webhook_subscriptions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "api_keys"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "sso_configs"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "biometric_device_registrations"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "slack_workspace_configs"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
