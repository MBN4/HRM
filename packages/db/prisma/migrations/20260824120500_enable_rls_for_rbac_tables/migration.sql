-- Extends Row-Level Security to the RBAC + branch-scoping tables added in
-- 0.4 (permissions, roles, role_permissions, user_roles, user_branches).
-- These are ordinary tenant-scoped tables like any other from 0.2 — the
-- exact same policy pattern, role, and grants apply. This does NOT modify
-- any existing policy; it is the same pattern applied to new tables, same
-- as the `tenants`/`tenant_domains` exemption was NOT re-litigated here
-- (this migration only touches the five tables listed below).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "permissions",
  "roles",
  "role_permissions",
  "user_roles",
  "user_branches"
  TO hrm_app;

ALTER TABLE "permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permissions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;

ALTER TABLE "user_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_branches" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "permissions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "roles"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "role_permissions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "user_roles"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "user_branches"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
