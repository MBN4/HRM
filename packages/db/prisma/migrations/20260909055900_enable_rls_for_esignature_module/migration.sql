-- E-signatures (step 3.5.3) — see docs/conventions/e-signatures.md.
--
-- `signature_requests`/`signature_signers`/`signature_certificates` are
-- ordinary tenant-scoped tables — identical `tenant_isolation` policy
-- pattern to every other tenant-owned table in this schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "signature_requests",
  "signature_signers",
  "signature_certificates"
  TO hrm_app;

ALTER TABLE "signature_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_requests" FORCE ROW LEVEL SECURITY;

ALTER TABLE "signature_signers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_signers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "signature_certificates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_certificates" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "signature_requests"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "signature_signers"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "signature_certificates"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- `signature_events` is ALSO tenant-scoped RLS (reads are still limited to
-- the current tenant, same policy shape), but — exactly like `audit_log`
-- (see the `enable_rls_for_audit_and_custom_fields` migration) —
-- `hrm_app` is granted only SELECT and INSERT, never UPDATE or DELETE.
-- This is the DB-LEVEL immutability guarantee for the evidentiary trail:
-- even a fully compromised application process, connected as `hrm_app`,
-- cannot alter or erase a recorded signing event — REVOKE is issued
-- explicitly (on top of simply never granting it) as defense-in-depth
-- against a future migration accidentally adding a blanket grant.
-- Cascading deletes from a `Tenant`/`SignatureRequest` row being deleted
-- are unaffected — `ON DELETE CASCADE` is enforced by the FK constraint
-- itself, not by the deleting session's own DELETE privilege on this table.
GRANT SELECT, INSERT ON "signature_events" TO hrm_app;
REVOKE UPDATE, DELETE ON "signature_events" FROM hrm_app;

ALTER TABLE "signature_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "signature_events"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
