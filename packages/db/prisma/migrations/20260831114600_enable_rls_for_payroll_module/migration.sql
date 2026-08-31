-- `exchange_rates` is exempt from Row-Level Security, same as
-- `country_packs` (see the comment on the ExchangeRate model in
-- schema.prisma): it is global, objective market reference data with no
-- `tenant_id` column for a policy to filter on. No ENABLE/FORCE ROW LEVEL
-- SECURITY and no policy here — deliberate, not an oversight.
--
-- Only SELECT is granted: writing rates is an admin/seeding operation
-- today (a real rate-provider integration is future work) — the same
-- "owner-role-writes-only" posture `country_packs` already takes.
GRANT SELECT ON "exchange_rates" TO hrm_app;

-- Every other Payroll table (step 2.1) IS tenant-scoped — ordinary RLS
-- applies, identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "payroll_component_definitions",
  "payroll_runs",
  "payroll_run_lines",
  "payslip_documents",
  "payroll_bank_exports"
  TO hrm_app;

ALTER TABLE "payroll_component_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_component_definitions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_runs" FORCE ROW LEVEL SECURITY;

ALTER TABLE "payroll_run_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_run_lines" FORCE ROW LEVEL SECURITY;

ALTER TABLE "payslip_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payslip_documents" FORCE ROW LEVEL SECURITY;

ALTER TABLE "payroll_bank_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_bank_exports" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payroll_component_definitions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "payroll_runs"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "payroll_run_lines"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "payslip_documents"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "payroll_bank_exports"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
