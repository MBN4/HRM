# Tenancy model / Row-Level Security (RLS)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.2 — `packages/db`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.2 tenancy model / Row-Level
Security" entry) for the full file list and verification notes.

- Every tenant-scoped table carries a `tenantId` column (Postgres native
  `uuid`, via Prisma `@db.Uuid` — **not** `TEXT`; RLS policies below cast
  `current_setting(...)::uuid` and need the column type to match), a
  composite index/unique constraint leading with `tenantId`, and a foreign
  key to `Tenant.id`. `Tenant` itself has no `tenantId` (it IS the tenant)
  and is NOT subject to RLS — resolving which tenant a request belongs to
  has to happen before a tenant context exists to filter by.
  `TenantDomain` (added in step 0.3, for custom-domain resolution — see
  [tenant-resolution.md](./tenant-resolution.md)) is the only other table
  with this same exemption, for the same reason.
- Self-relations (`Branch.parentBranchId`, `Department.parentDepartmentId`)
  use a **composite** FK of `(tenantId, parentId) -> (tenantId, id)`, not a
  plain `id -> id` FK. This guarantees a row's parent belongs to the same
  tenant at the schema level, independent of and in addition to RLS —
  defense-in-depth, per the project's non-negotiables (see CLAUDE.md § 2).
- Per-tenant-unique columns (`User.email`, `CostCenter.code`,
  `Branch.name`, `Department.(branchId, name)`) use a composite
  `@@unique([tenantId, ...])`, never a bare `@@unique([...])` — uniqueness
  is scoped per tenant, not global.
- DB column names are `snake_case` (via Prisma `@map`/`@@map`); Prisma
  field names stay `camelCase`. Chosen so hand-written RLS/raw-SQL
  migrations don't need to double-quote camelCase identifiers everywhere.
- **Row-Level Security** is the hard isolation boundary — enforced in
  Postgres, not just in application code:
  - Enabled by hand-written SQL in the
    `prisma/migrations/<ts>_enable_row_level_security/migration.sql`
    migration (Prisma has no RLS DSL, so this can't be generated from
    `schema.prisma`). Policy: `tenant_id = current_setting('app.current_tenant')::uuid`,
    applied to both `USING` (reads) and `WITH CHECK` (writes), on every
    tenant-scoped table.
  - No `missing_ok` on `current_setting` — a query issued without a tenant
    context set fails loudly (Postgres error) instead of silently
    returning zero rows. A forgotten tenant-context call is a bug we want
    surfaced immediately, not masked as "no results."
  - **Two DB roles, on purpose.** Postgres skips RLS for superusers, for
    any role with `BYPASSRLS`, and for the table owner (unless
    `FORCE ROW LEVEL SECURITY` is set) — so the migration role can never be
    the role the running app queries through, or RLS silently does
    nothing:
    - `hrm` (`DATABASE_URL`) — owns the schema, runs migrations, superuser
      in local dev. Used for `prisma migrate`, seeding, and admin/bootstrap
      tooling only.
    - `hrm_app` (`APP_DATABASE_URL`) — plain login role, `NOSUPERUSER
NOBYPASSRLS`, created by the RLS migration, granted only
      `SELECT/INSERT/UPDATE/DELETE` on tenant-scoped tables and `SELECT`
      on `tenants`. RLS is enforced against this role. **All** tenant-
      scoped, request-time queries must go through it. Every table also
      has `FORCE ROW LEVEL SECURITY` set as a second line of defense (does
      not help against a superuser connection, but protects against a
      future change of table ownership).
    - The `hrm_app` password shipped in the migration is a local-dev
      default, consistent with the other plaintext dev credentials already
      in this repo. Any non-local environment (staging, prod, an on-prem
      install) **must** rotate it immediately after migrating and manage
      that secret outside source control.
  - **`withTenantContext(tenantId, fn)`** (`packages/db/src/tenant-context.ts`)
    is the only sanctioned way to run a tenant-scoped query. It validates
    `tenantId` is a UUID, opens a Prisma transaction against `appPrisma`
    (the `hrm_app`-role client), runs
    `SELECT set_config('app.current_tenant', $1, true)` — the parameterized
    equivalent of `SET LOCAL`, so it's transaction-local and immune to SQL
    injection — then calls `fn(tx)`. Postgres resets the setting
    automatically at COMMIT/ROLLBACK, so there is no separate "reset" step
    and no way for tenant A's context to leak onto a pooled connection a
    later, unrelated request reuses.
  - `packages/db` exports two Prisma Client singletons: `prisma` (owner
    role — admin/migration/seeding use only) and `appPrisma` (restricted
    role — only ever used through `withTenantContext`, never called
    directly). Application code (`apps/api`) must use `withTenantContext`,
    never `prisma`, for anything that touches tenant-scoped tables.
- Verified by `packages/db/test/tenant-isolation.spec.ts`: tenant A cannot
  read tenant B's rows even with a crafted `where: { tenantId: B }` clause,
  cannot read B's row by primary key, cannot write a row tagged as B
  (`WITH CHECK`), and a query issued with no tenant context at all fails
  instead of silently succeeding.
- Deferred to later steps, tracked so they aren't silently forgotten:
  `attendance_records` and `audit_log` must be created as **partitioned**
  tables from day one (partition key must be part of every PK/unique
  constraint — see the comment block above the `Tenant` model in
  `schema.prisma`), and the same RLS pattern applies to them. Both now
  satisfy this PARTITION-READY shape: `audit_log`'s composite
  `(id, occurredAt)` PK since 0.9 (see
  [audit-custom-fields.md](./audit-custom-fields.md)) and
  `attendance_records`'s composite `(id, workDate)` PK since 1.3 (see
  [attendance.md](./attendance.md)) — the actual `PARTITION BY RANGE`
  migration for either is still Phase 5.2, not yet done.
