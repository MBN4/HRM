-- Step 8.1 Part 4: backfill the new `leave.defaults.manage` permission for every EXISTING
-- tenant and grant it to TENANT_ADMIN / CEO / HR_MANAGER (new tenants get it from
-- seedSystemRolesAndPermissions). Idempotent. No table changes — defaults are stored in the
-- existing `tenant_country_overrides` rows.
INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", 'leave.defaults.manage'
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = 'leave.defaults.manage');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'leave.defaults.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER')
ON CONFLICT DO NOTHING;
