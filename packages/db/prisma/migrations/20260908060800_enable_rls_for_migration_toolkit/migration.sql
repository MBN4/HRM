-- Data migration & onboarding toolkit (step 3.5.1) — every new table here IS
-- tenant-scoped, ordinary RLS applies, identical `tenant_isolation` policy
-- pattern to every other tenant-owned table in this schema (see
-- docs/conventions/tenancy-rls.md and docs/conventions/data-migration.md).

GRANT SELECT, INSERT, UPDATE, DELETE ON "column_mapping_templates" TO hrm_app;
ALTER TABLE "column_mapping_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "column_mapping_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "column_mapping_templates"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "import_batches" TO hrm_app;
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_batches"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "import_row_errors" TO hrm_app;
ALTER TABLE "import_row_errors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_row_errors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_row_errors"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "migrated_attendance_summaries" TO hrm_app;
ALTER TABLE "migrated_attendance_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "migrated_attendance_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "migrated_attendance_summaries"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "migrated_payslip_records" TO hrm_app;
ALTER TABLE "migrated_payslip_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "migrated_payslip_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "migrated_payslip_records"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
