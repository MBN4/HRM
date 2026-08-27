-- Employee module (step 1.1). Five ordinary tenant-scoped tables — no
-- exemption reasoning applies here (unlike CountryPack/NotificationTemplate):
-- an Employee row always belongs to exactly one tenant and nothing about
-- resolving it needs to run before a tenant context exists, so this is the
-- identical `tenant_isolation` policy pattern used for every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "employees",
  "employee_dependents",
  "employee_emergency_contacts",
  "employee_documents",
  "employee_import_jobs"
  TO hrm_app;

ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" FORCE ROW LEVEL SECURITY;

ALTER TABLE "employee_dependents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_dependents" FORCE ROW LEVEL SECURITY;

ALTER TABLE "employee_emergency_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_emergency_contacts" FORCE ROW LEVEL SECURITY;

ALTER TABLE "employee_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_documents" FORCE ROW LEVEL SECURITY;

ALTER TABLE "employee_import_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_import_jobs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "employees"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "employee_dependents"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "employee_emergency_contacts"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "employee_documents"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "employee_import_jobs"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
