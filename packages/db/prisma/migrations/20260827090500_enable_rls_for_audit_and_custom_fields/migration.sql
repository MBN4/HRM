-- Audit log + custom fields (step 0.9).
--
-- `custom_field_definitions`/`custom_field_value_sets` are ordinary
-- tenant-scoped tables — identical `tenant_isolation` policy pattern to
-- every other tenant-owned table in this schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "custom_field_definitions",
  "custom_field_value_sets"
  TO hrm_app;

ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "custom_field_value_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_value_sets" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "custom_field_definitions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "custom_field_value_sets"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- `audit_log` is ALSO tenant-scoped RLS (reads are still limited to the
-- current tenant, same policy shape), but — UNLIKE every other tenant-owned
-- table in this schema — `hrm_app` is granted only SELECT and INSERT, never
-- UPDATE or DELETE. This is the DB-LEVEL immutability guarantee: even a
-- fully compromised application process, connected as `hrm_app`, cannot
-- alter or erase a written audit row — REVOKE is issued explicitly (on top
-- of simply never granting it) as defense-in-depth against a future
-- migration accidentally adding a blanket grant. `WITH CHECK` on the
-- `tenant_isolation` policy below still matters for the INSERT path (a
-- session can only ever insert a row tagged as its own tenant); `USING`
-- still matters for SELECT (a session can only ever read its own tenant's
-- rows). Cascading deletes from a `Tenant` row being deleted are unaffected
-- by this REVOKE — `ON DELETE CASCADE` is enforced by the FK constraint
-- itself, not by the deleting session's own DELETE privilege on the child
-- table, so tenant off-boarding still cleans up its audit trail.
GRANT SELECT, INSERT ON "audit_log" TO hrm_app;
REVOKE UPDATE, DELETE ON "audit_log" FROM hrm_app;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_log"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
