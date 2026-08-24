-- Row-Level Security: the hard tenant-isolation boundary.
--
-- Postgres silently SKIPS row security policies for:
--   1. superusers,
--   2. any role with the BYPASSRLS attribute, and
--   3. the owner of the table (unless the table has FORCE ROW LEVEL
--      SECURITY set).
--
-- The role this migration runs as (whatever DATABASE_URL points at) owns
-- every table created in the previous migration and, in local dev, is a
-- superuser — so it always bypasses RLS no matter what we do here. That is
-- fine: it is the *migration/admin* role, not the role the running
-- application connects as.
--
-- The application must connect as `hrm_app` instead: a plain login role
-- with none of the three bypasses above. `FORCE ROW LEVEL SECURITY` is set
-- anyway as a second line of defense (e.g. if a future migration changes
-- table ownership to `hrm_app` itself), even though it does not help against
-- a superuser connection.
--
-- SECURITY NOTE: the password below is a local-dev default, consistent with
-- the other plaintext dev credentials already in this repo (docker-compose,
-- .env.example). Any non-local environment (staging, prod, a customer's
-- on-prem install) MUST rotate it immediately after this migration runs,
-- e.g. `ALTER ROLE hrm_app WITH PASSWORD '<generated-secret>';`, and manage
-- that secret outside of source control.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_app') THEN
    CREATE ROLE hrm_app LOGIN PASSWORD 'hrm_app_dev_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

-- GRANT ... ON DATABASE needs the current database's name, which varies
-- across environments (dev/test/staging/prod/on-prem installs all use
-- different database names) — resolve it dynamically instead of hardcoding.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hrm_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO hrm_app;

-- `tenants` is not tenant-scoped and has no RLS policy (see schema.prisma):
-- the app only ever needs to read it while resolving which tenant a request
-- belongs to, never write it through this role.
GRANT SELECT ON "tenants" TO hrm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "branches",
  "departments",
  "designations",
  "cost_centers",
  "users"
  TO hrm_app;

-- No sequence grants are needed: every primary key is a client-generated
-- UUID (Prisma's `@default(uuid())`), not a database sequence.

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;

ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;

ALTER TABLE "designations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "designations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "cost_centers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cost_centers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

-- Policy: a row is visible/writable only when its tenant_id matches the
-- tenant bound to the current transaction via `app.current_tenant` (see
-- `withTenantContext` in packages/db/src/tenant-context.ts). No missing_ok
-- fallback is used on `current_setting`, so a query issued through `hrm_app`
-- WITHOUT a tenant context set fails loudly instead of silently returning
-- zero rows — a forgotten `withTenantContext` call is a bug we want to
-- surface immediately, not mask.
--
-- USING governs which existing rows are visible (SELECT/UPDATE/DELETE).
-- WITH CHECK governs which rows may be written (INSERT/UPDATE), preventing
-- a tenant-A session from ever inserting or re-tagging a row as tenant B's,
-- even via a crafted payload.
CREATE POLICY tenant_isolation ON "branches"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "departments"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "designations"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "cost_centers"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "users"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
