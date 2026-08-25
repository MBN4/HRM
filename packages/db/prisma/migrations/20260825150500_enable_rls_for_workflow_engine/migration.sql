-- Workflow / approval engine (step 0.7). All five tables carry a
-- `tenant_id` and are ordinary tenant-scoped data — identical
-- `tenant_isolation` policy pattern to every other tenant-owned table.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "workflow_templates",
  "workflow_steps",
  "workflow_instances",
  "workflow_instance_steps",
  "workflow_actions"
  TO hrm_app;

ALTER TABLE "workflow_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_templates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_steps" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workflow_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instances" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workflow_instance_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance_steps" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workflow_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_actions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "workflow_templates"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "workflow_steps"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "workflow_instances"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "workflow_instance_steps"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "workflow_actions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
