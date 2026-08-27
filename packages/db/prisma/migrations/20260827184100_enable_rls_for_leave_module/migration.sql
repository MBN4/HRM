-- Leave module (step 1.2). Three ordinary tenant-scoped tables — no
-- exemption reasoning applies (unlike CountryPack/NotificationTemplate):
-- a leave balance/request/accrual run always belongs to exactly one tenant,
-- so this is the identical `tenant_isolation` policy pattern used for every
-- other tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "leave_balances",
  "leave_requests",
  "leave_accrual_runs"
  TO hrm_app;

ALTER TABLE "leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_balances" FORCE ROW LEVEL SECURITY;

ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;

ALTER TABLE "leave_accrual_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_accrual_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "leave_balances"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "leave_requests"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "leave_accrual_runs"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
