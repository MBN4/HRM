-- Step 12.1 (multi-legal-entity) — RLS + grants for `legal_entities` (the identical `tenant_isolation`
-- pattern every tenant table uses, docs/conventions/tenancy-rls.md), the one-default-per-tenant
-- invariant, the DEFAULT-ENTITY BACKFILL for every existing tenant, and the `entity.manage`
-- permission backfilled for every existing tenant. Idempotent. See docs/conventions/legal-entities.md.

-- Exactly one default legal entity per tenant (what a null `branches.legal_entity_id` resolves to).
CREATE UNIQUE INDEX IF NOT EXISTS "legal_entities_one_default_per_tenant"
  ON "legal_entities" ("tenant_id") WHERE "is_default" = true;

-- BACKFILL (runs as the owner, BEFORE RLS is forced on the new table): one default entity per
-- existing tenant, named/countried from the tenant itself, and every existing branch linked to it.
-- Nothing about a single-entity tenant changes — its branches simply gain an identity to print.
INSERT INTO "legal_entities" ("id", "tenant_id", "legal_name", "country_code", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", t."name", t."default_country_code", true, now(), now()
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."tenant_id" = t."id" AND e."is_default" = true);

UPDATE "branches" b
SET "legal_entity_id" = e."id"
FROM "legal_entities" e
WHERE e."tenant_id" = b."tenant_id" AND e."is_default" = true AND b."legal_entity_id" IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_entities" TO hrm_app;

ALTER TABLE "legal_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_entities" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "legal_entities";
CREATE POLICY tenant_isolation ON "legal_entities"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", 'entity.manage'
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = 'entity.manage');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'entity.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER')
ON CONFLICT DO NOTHING;
