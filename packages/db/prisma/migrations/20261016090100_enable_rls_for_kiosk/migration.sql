-- Step 11.1 (kiosk mode) — RLS + grants for the two new tenant-owned tables (the identical
-- `tenant_isolation` pattern every tenant table uses, docs/conventions/tenancy-rls.md), plus the
-- `kiosk.manage` permission backfilled for every EXISTING tenant (new tenants get it from
-- seedSystemRolesAndPermissions). Idempotent.
--
-- `kiosks` is read BEFORE a tenant is known (the device token establishes the tenant, exactly like
-- `api_keys`), by the owner client — a deliberate, narrow exception documented in kiosk.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON "kiosks", "employee_kiosk_pins" TO hrm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kiosks', 'employee_kiosk_pins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenant_id" = current_setting(''app.current_tenant'')::uuid) WITH CHECK ("tenant_id" = current_setting(''app.current_tenant'')::uuid)',
      t
    );
  END LOOP;
END $$;

INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", 'kiosk.manage'
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = 'kiosk.manage');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'kiosk.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER')
ON CONFLICT DO NOTHING;
