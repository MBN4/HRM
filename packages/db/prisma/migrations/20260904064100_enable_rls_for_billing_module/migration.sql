-- Every billing table (step 4.2) is tenant-scoped — ordinary RLS applies,
-- identical `tenant_isolation` policy pattern to every other tenant-owned
-- table in this schema (see docs/conventions/tenancy-rls.md). Note that
-- `subscriptions` itself already has RLS enabled since step 0.6 — the new
-- Stripe columns added in the prior migration are covered by that
-- existing policy with no change needed here.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "invoices", "payment_methods", "billing_events"
  TO hrm_app;

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" FORCE ROW LEVEL SECURITY;
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "invoices"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "payment_methods"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "billing_events"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
