-- Notifications hub (step 0.8). `notifications`/`notification_deliveries`/
-- `notification_preferences` all carry a `tenant_id` and are ordinary
-- tenant-scoped data — identical `tenant_isolation` policy pattern to every
-- other tenant-owned table. `notification_templates` is deliberately
-- EXCLUDED here: it is global, system-owned reference data (no `tenant_id`
-- column), the same RLS exemption as `country_packs` (see the 0.5 RLS
-- migration) — only a GRANT SELECT, no ENABLE/FORCE ROW LEVEL SECURITY, no
-- policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "notifications",
  "notification_deliveries",
  "notification_preferences"
  TO hrm_app;

GRANT SELECT ON "notification_templates" TO hrm_app;

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;

ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_deliveries" FORCE ROW LEVEL SECURITY;

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "notifications"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "notification_deliveries"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "notification_preferences"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
