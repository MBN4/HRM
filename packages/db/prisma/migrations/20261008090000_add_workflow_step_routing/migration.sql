-- AlterTable
ALTER TABLE "workflow_instance_steps" ADD COLUMN     "routing" JSONB;

-- Step 7.2: backfill the new system CEO role for every EXISTING tenant (new
-- tenants get it from seedSystemRolesAndPermissions). The CEO holds every
-- permission, so mirror each tenant's TENANT_ADMIN grants. Idempotent.
INSERT INTO "roles" ("id", "tenant_id", "name", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'CEO', true, now(), now()
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."tenant_id" = t."id" AND r."name" = 'CEO');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT ceo."tenant_id", ceo."id", p."id"
FROM "roles" ceo
JOIN "permissions" p ON p."tenant_id" = ceo."tenant_id"
WHERE ceo."name" = 'CEO'
ON CONFLICT DO NOTHING;
