-- Step 10.1 (engagement & culture) — RLS + grants for the new tenant-owned tables, the
-- identical `tenant_isolation` pattern every other tenant table uses
-- (docs/conventions/tenancy-rls.md), plus the two new permissions backfilled for EVERY
-- EXISTING tenant (new tenants get them from seedSystemRolesAndPermissions). Idempotent.

-- Ordinary read/write tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "recognition_categories", "recognitions", "recognition_recipients", "recognition_balances",
  "surveys", "survey_questions", "survey_assignments", "survey_tallies",
  "feed_posts", "feed_reactions", "feed_comments"
TO hrm_app;

-- A submitted survey response is IMMUTABLE for the app role: INSERT + SELECT only. No UPDATE
-- means a bug (or an attacker with the app credentials) cannot re-attach an identity to an
-- anonymous response after the fact, nor rewrite what someone said; no DELETE means responses
-- can't be quietly dropped either. Same "make it impossible at the DB layer" posture as
-- `audit_log`'s REVOKE UPDATE/DELETE (docs/conventions/audit-custom-fields.md).
GRANT SELECT, INSERT ON "survey_responses", "survey_answers" TO hrm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recognition_categories', 'recognitions', 'recognition_recipients', 'recognition_balances',
    'surveys', 'survey_questions', 'survey_assignments', 'survey_responses', 'survey_answers',
    'survey_tallies', 'feed_posts', 'feed_reactions', 'feed_comments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenant_id" = current_setting(''app.current_tenant'')::uuid) WITH CHECK ("tenant_id" = current_setting(''app.current_tenant'')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Permissions: `recognition.give` (broad participation: give recognition, react, comment) for
-- every system role; `engagement.manage` (surveys, categories, moderation, overview) for the
-- admin tier. Idempotent backfill for existing tenants.
INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", k.key
FROM "tenants" t
CROSS JOIN (VALUES ('recognition.give'), ('engagement.manage')) AS k(key)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = k.key);

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'recognition.give'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'engagement.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER')
ON CONFLICT DO NOTHING;
