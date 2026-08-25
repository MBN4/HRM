# HRM — Project Memory

This file is the persistent memory for this project. Read it before starting
new work, and keep it up to date as the system evolves: append to the BUILD
LOG when a step lands, update NOT YET BUILT as items get built, and extend
CONVENTIONS as architectural decisions get made.

## 1. Overview

HRM is a **global, multi-tenant HR SaaS**, sold under two delivery models:

- **Rented SaaS** — vendor-hosted, multi-tenant, subscription-billed.
- **Lifetime on-prem license** — a customer runs the same codebase on their
  own infrastructure under a perpetual license, single-tenant in practice but
  built from the same multi-tenant core (no forked codebase).

Both delivery models ship from **one codebase**. Behavioral differences
between SaaS and on-prem (billing, licensing checks, update cadence) are
handled by configuration and feature flags, never by branching the code.

## 2. Non-negotiables

- **Scalable** — designed to scale to 20M users. Must degrade gracefully
  under load (backpressure, queueing, circuit breaking) rather than fail
  hard.
- **Secure** — defense-in-depth is mandatory, not optional:
  - Row-Level Security (RLS) for tenant data isolation at the database layer
  - RBAC for authorization
  - Encryption (in transit and at rest)
  - Audit logging of sensitive actions
  - No single layer is trusted alone — assume any one control can fail
- **Customizable without forking** — every country's/tenant's differences
  (legal, payroll, holidays, statutory fields, workflows) are expressed via:
  - **Country Packs** — pluggable, versioned configuration per country
  - **Tenant overrides** — tenant-level configuration layered on top
  - **Feature flags** — for gradual rollout and tenant-specific toggles
  - Forking the codebase per customer/country is explicitly disallowed.
- **Multi-tenant** — a single deployment serves many tenants; tenant
  isolation is a first-class architectural concern, not an afterthought.

## 3. Stack & workspace map

**Stack**: Turborepo + pnpm workspaces · NestJS + TypeScript (API) · Next.js
14 App Router (web apps) · Prisma + PostgreSQL 16 · Redis · BullMQ · MinIO
(S3-compatible object storage, local dev).

| Path              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `apps/api`        | NestJS backend — all business logic, REST API                 |
| `apps/admin`      | Vendor super-admin console (Next.js App Router)               |
| `apps/portal`     | Tenant org portal (Next.js App Router)                        |
| `packages/db`     | Prisma schema + generated client (`@hrm/db`)                  |
| `packages/shared` | Shared types, DTOs, zod validators, constants (`@hrm/shared`) |
| `packages/config` | Shared ESLint / TypeScript / Prettier config (`@hrm/config`)  |

Infra for local dev: `docker-compose.yml` runs Postgres 16, Redis, and MinIO.
Every app/package that needs environment variables documents them in its own
`.env.example`.

## 4. Conventions

> This section grows as later steps make architectural decisions. Do not
> leave placeholders unresolved — update this section in the same step that
> makes the decision.

- **Tenancy model** (defined in step 0.2 — `packages/db`):
  - Every tenant-scoped table carries a `tenantId` column (Postgres native
    `uuid`, via Prisma `@db.Uuid` — **not** `TEXT`; RLS policies below cast
    `current_setting(...)::uuid` and need the column type to match), a
    composite index/unique constraint leading with `tenantId`, and a foreign
    key to `Tenant.id`. `Tenant` itself has no `tenantId` (it IS the tenant)
    and is NOT subject to RLS — resolving which tenant a request belongs to
    has to happen before a tenant context exists to filter by.
    `TenantDomain` (added in step 0.3, for custom-domain resolution — see
    Tenant resolution below) is the only other table with this same
    exemption, for the same reason.
  - Self-relations (`Branch.parentBranchId`, `Department.parentDepartmentId`)
    use a **composite** FK of `(tenantId, parentId) -> (tenantId, id)`, not a
    plain `id -> id` FK. This guarantees a row's parent belongs to the same
    tenant at the schema level, independent of and in addition to RLS —
    defense-in-depth, per the non-negotiables above.
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
      directly). Application code (`apps/api`, once request-scoped tenant
      binding lands in 0.3) must use `withTenantContext`, never `prisma`,
      for anything that touches tenant-scoped tables.
  - Verified by `packages/db/test/tenant-isolation.spec.ts`: tenant A cannot
    read tenant B's rows even with a crafted `where: { tenantId: B }` clause,
    cannot read B's row by primary key, cannot write a row tagged as B
    (`WITH CHECK`), and a query issued with no tenant context at all fails
    instead of silently succeeding.
  - Deferred to later steps, tracked so they aren't silently forgotten:
    `attendance` and `audit_log` (0.9) must be created as **partitioned**
    tables from day one (partition key must be part of every PK/unique
    constraint — see the comment block above the `Tenant` model in
    `schema.prisma`), and the same RLS pattern applies to them.
- **Country packs** (defined in step 0.5 — `packages/db`, `packages/shared`,
  `apps/api/src/country-packs`):
  - **THE RULE.** No module may ever branch on a country code
    (`if (countryCode === 'US')` or equivalent). Every behavior that
    legally/culturally differs by country — currency, weekend days, leave
    entitlements, public holidays, income tax, statutory contributions,
    required employee fields, payslip layout, payroll mode — must be read
    from `CountryPackResolutionService`'s resolved effective config, never
    hardcoded elsewhere. The two reference packs (USA, Qatar — see below)
    exist specifically to prove this: same code path, opposite behavior,
    driven entirely by data.
  - **Schema** (`packages/shared/src/validators/country-pack.validator.ts`,
    `countryPackConfigSchema`): `locale` (currencyCode/currencySymbol/
    numberFormat/dateFormat/defaultLanguage/rtl/firstDayOfWeek),
    `workingTime` (standardWeeklyHours/weekendDays[]/overtimeRules),
    `leaveDefaults` (annual/sick/maternity/paternity day counts),
    `publicHolidays` (a calendar keyed by 4-digit year, seedable one year at
    a time), `tax` (`{ layers: TaxLayer[] }` — see Rules engine below;
    empty array is valid and means "no income tax", e.g. Qatar — this is a
    data state, not a special-cased skip), `statutory` (`{ components:
StatutoryComponent[] }`), `requiredEmployeeFields` (opaque string keys,
    e.g. `["SSN","W4"]` / `["QATAR_ID","VISA_SPONSORSHIP"]` — meaning lives
    in the future employee-fields module, not here), `payslipTemplate`
    (language + ordered line items), `payrollMode` (`CALCULATE` |
    `DELEGATE`), `hostingRegionHint` (advisory only, never a hard
    data-residency enforcement by this schema alone).
  - **Rules engine — the SAFE evaluator (SECURITY BOUNDARY).**
    `tax.layers`/`statutory.components` entries with `kind: 'FORMULA'`
    carry an `Expr` value — a fixed, whitelisted JSON AST (`{type:'const'|
'var'|'binary'|'clamp', ...}`, `@hrm/shared`'s `exprSchema`/
    `ALLOWED_EXPR_VARIABLES`/`ALLOWED_EXPR_OPERATORS`) — **never** a string
    to be parsed or `eval`'d, and there is no mechanism anywhere in this
    system for a pack/override to carry executable code. `apps/api/src/
country-packs/rules-engine/expression-evaluator.ts`'s `evaluateExpression`
    is the ONLY function that executes it: a structural tree-walking
    interpreter that matches every node/operator/variable against that
    same fixed whitelist and throws `UnsafeExpressionError` on anything
    else. This is validated on TWO independent layers — `exprSchema` at
    every pack/override write AND read, and the evaluator's own runtime
    check — consistent with this project's "no single layer of security is
    trusted alone" posture; extending the whitelist (a new operator/
    variable) is a deliberate, reviewed code change, never a runtime
    config option. `PROGRESSIVE_BRACKETS`/`FLAT_RATE` (tax) and
    `PERCENTAGE`/`TIERED_BY_YEARS_OF_SERVICE` (statutory) are fixed, generic
    algorithms parameterized entirely by pack data — `FORMULA` exists only
    for what those shapes can't express. `apps/api/src/country-packs/
rules-engine/{tax-calculator,statutory-calculator}.ts` compute layers/
    components from this data; the SAME function computes every country's
    result, e.g. `computeMultiLayerTax(pack.tax.layers, variables)` for
    both a 4-layer US pack and Qatar's `layers: []`.
  - **Country resolution.** `CountryPackResolutionService.
resolveCountryCodeForBranch(branchId)`: `Branch.countryCode` (required
    at the DB level today) is the primary source; `Tenant.defaultCountryCode`
    is only a fallback for a branch without one — defensive/forward-looking
    given the current NOT NULL column, per this note's original placeholder
    here since 0.2/0.3. `resolveEffectiveConfig(countryCode)` then loads
    the active `CountryPack` (`isActive: true`, highest `version`) — no
    active pack for a country is a loud `404` (`CountryPackNotFoundError`),
    never a silent generic default, consistent with the RLS
    "no `missing_ok`" philosophy elsewhere in this file.
  - **Two-layer override model.** `CountryPack.config` (system-owned legal/
    cultural defaults, versioned per country) merged with an optional
    `TenantCountryOverride.overrides` (a tenant's diff on top, e.g. "25
    days annual leave vs. the pack's 21-day legal floor") =
    `mergeCountryPackConfig()`'s effective config
    (`apps/api/src/country-packs/country-pack-override.util.ts`). Only
    `leaveDefaults`/`workingTime`/`requiredEmployeeFields`/`payslipTemplate`
    are ever tenant-overridable — `tenantCountryOverrideSchema` is `.strict()`,
    so an override payload naming `tax`/`statutory`/`locale`/`payrollMode`
    fails validation outright; a tenant can never weaken a legal/compliance
    default. Bounds are enforced where sensible, e.g. `leaveDefaults`: a
    tenant may only grant MORE than the pack's legal floor, never less
    (`assertLeaveBoundsRespected`, a `400` at override write-time via `PUT
/country-packs/overrides/:countryCode`) — and defensively clamped UP to
    the floor again at every resolution (`mergeCountryPackConfig`), in case
    a later CountryPack version raises the floor after the override was
    written.
  - **Tenancy of the two tables**: `CountryPack` has NO `tenantId` — it is
    global, system-owned reference data every tenant's branches resolve
    against, so (like `Tenant`/`TenantDomain`) it is NOT subject to RLS;
    `hrm_app` is granted `SELECT` only (writable today only via the owner
    role, i.e. seeding — a real admin-editable UI is later work, tracked in
    § Not yet built). `TenantCountryOverride` IS tenant-scoped — ordinary
    RLS applies, identical `tenant_isolation` policy pattern to every other
    tenant-owned table in this schema.
  - **Reference packs — USA and Qatar** (`packages/db/src/
seed-country-packs.ts`, `seedCountryPacks()`, called by `prisma/seed.ts`;
    figures are illustrative/rounded for a reference implementation, not
    certified legal/tax guidance — a real deployment needs its packs
    authored/reviewed by whoever owns payroll compliance for that market):
    USD/Sat-Sun weekend/LTR English/4-layer tax (federal progressive
    brackets + a flat illustrative state rate + FICA social security with a
    wage-base cap + FICA medicare uncapped) + FUTA as an employer statutory
    component/`["SSN","W4"]` required, vs. QAR/Fri-Sat weekend/RTL Arabic/
    `tax.layers: []` (no income tax) + a tiered-by-years-of-service
    end-of-service gratuity as the statutory component/
    `["QATAR_ID","VISA_SPONSORSHIP"]` required — proving the identical
    schema and resolution/merge/rules-engine code drives opposite real
    behavior.
  - **Demo endpoints** (`apps/api/src/country-packs/country-packs.controller.ts`):
    `GET /country-packs/effective?branchId=` (defaults to the caller's
    context branch) is this step's required proof endpoint; `GET
/country-packs/effective/:countryCode` resolves directly by country;
    `PUT /country-packs/overrides/:countryCode` is the write side of the
    two-layer model, deny-by-default behind a new permission,
    `country_pack.override.manage` (seeded onto `TENANT_ADMIN` via
    `ALL_PERMISSIONS` and explicitly onto `HR_MANAGER` — see
    `packages/shared/src/constants/permissions.ts`), same
    `@RequirePermissions()` + `PermissionsGuard`-as-interceptor pattern as
    the rest of RBAC.
  - Verified by `apps/api/src/country-packs/rules-engine/*.spec.ts` (unit:
    the evaluator's whitelist rejects out-of-whitelist nodes/operators/
    variables; `exprSchema` rejects the same independently; a real
    multi-layer US tax example and a real Qatar end-of-service example
    computed from the actual seeded pack data) and
    `apps/api/test/country-packs.e2e-spec.ts` (e2e over real HTTP: a US
    branch and a QA branch resolving opposite behavior through the same
    endpoint, the override layering over and being clamped/rejected against
    the pack's leave floor, an override payload naming a non-overridable
    section rejected, deny-by-default RBAC on the write route, and — the
    RLS proof — tenant A's override never leaking into tenant B's
    resolution of the same country).
- **Tenant resolution** (defined in step 0.3 — `apps/api/src/tenancy`):
  - `TenantResolutionService` tries strategies **in order** until one
    matches, configurable via `TENANT_RESOLUTION_STRATEGIES` (comma list;
    default `subdomain,custom_domain,header`):
    1. **subdomain** — `acme.<TENANT_BASE_DOMAIN>` → `Tenant.slug = "acme"`.
       Disabled entirely if `TENANT_BASE_DOMAIN` is unset. Only a single
       label is matched (`acme`, not `acme.eu`) — a stray dot skips this
       strategy rather than guessing.
    2. **custom_domain** — exact `Host` header match against
       `TenantDomain.domain` (see Tenancy model → `TenantDomain` below).
    3. **header** — `TENANT_HEADER_NAME` (default `x-tenant-id`) carrying
       either the tenant's UUID `id` or its `slug`, for mobile/API clients
       with no per-tenant hostname.
  - All three query `appPrisma` **directly**, with no `withTenantContext` —
    `tenants` and `tenant_domains` are both RLS-exempt (see Tenancy model),
    precisely so resolution can run before a tenant context exists to open
    one with.
  - Unresolvable → `401 Unauthorized`. Routes marked `@Public()` (health
    checks, and eventually login) skip resolution entirely — no tenant, no
    transaction, and `@CurrentTenant()`/`TenantContextService.getTx()` won't
    work there. `TENANT_STATUS` (suspended/cancelled tenants) is
    deliberately **not** checked here — that's a licensing/billing concern
    for step 0.6, not "can we find this tenant."
  - **The whole rest of the request runs inside one transaction.**
    `TenantScopeInterceptor` (a global `APP_INTERCEPTOR`) resolves the
    tenant, then wraps everything downstream — remaining interceptors,
    pipes, the controller method — in a single `withTenantContext` call, so
    every query the handler makes is RLS-enforced, not just ones a
    developer remembers to wrap. The Observable from `next.handle()` is
    bridged into the transaction's callback via `firstValueFrom` (awaiting
    the Observable directly would resolve instantly with the Observable
    object itself, closing the transaction before the controller ever
    runs).
    **Known tradeoff**: this holds one pooled Postgres connection open for
    the full duration of every non-public request, including any slow I/O
    the handler does. Deliberate, per this step's brief ("RLS enforced for
    the whole request lifecycle") — but worth revisiting under 0.10
    (resilience) if it becomes a real bottleneck.
  - **Request context propagation is via `AsyncLocalStorage`, not
    REQUEST-scoped DI.** `tenant-context.store.ts` exports the raw
    `AsyncLocalStorage<RequestTenantStore>`; `TenantContextService`
    (injectable) and `@CurrentTenant()` (param decorator) both read from it.
    Chosen over Nest's REQUEST scope because REQUEST-scoped providers
    rebuild the whole DI subtree per request — real overhead this avoids —
    and because a decorator can't receive constructor-injected dependencies
    anyway. `RequestTenantStore` is per-in-flight-request, never shared or
    persisted, so it adds no cross-instance state (consistent with the
    STATELESS requirement — anything that must survive or be shared across
    requests belongs in Redis, not here).
  - **Context shape**: `{ tenantId, branchId, userId, roles, platform }`.
    Only `tenantId`/`platform` are populated today; `branchId`/`userId`/
    `roles` are wired through and typed now but stay `null` until auth
    (0.4) populates them — don't add new ad hoc "current user" plumbing
    later, extend this store instead.
  - **Platform (no-tenant) context — stub only.** `@PlatformRoute()` marks
    a route for the future vendor super-admin surface. It is rejected
    (`403`) unless `PLATFORM_MODE_ENABLED=true` (off by default), and even
    then `TenantScopeInterceptor` opens **no transaction** for it —
    `TenantContextService.getTx()` throws unconditionally on a platform
    request. There is no working tenant-data bypass today, by construction:
    this step only wires the seam (decorator + config flag + rejection
    path) so real RBAC- and audit-gated cross-tenant access has somewhere
    to attach later, without ever weakening a normal tenant request (a
    route without `@PlatformRoute()` is entirely unaffected by the flag).
  - Verified end-to-end over real HTTP (not just at the `withTenantContext`
    helper level) by `apps/api/test/tenant-resolution.e2e-spec.ts`: subdomain
    and header resolution both isolate tenant A from tenant B, a crafted
    `?tenantId=B` query param on a tenant-A-scoped request returns zero rows
    (RLS, not application code, is what blocks it), an unresolvable tenant
    gets `401`, `/health` works with no tenant, and a platform route is
    rejected while disabled.
- **Auth / RBAC model** (defined in step 0.4 — `apps/api/src/auth`,
  `apps/api/src/common/permissions`, `apps/api/src/tenancy`):
  - **Where auth-context population actually lives.** `TenantScopeInterceptor`
    (0.3) was EXTENDED, not replaced: after it resolves the tenant and opens
    the transaction, and unless the route is `@AllowAnonymous()`, it also
    verifies the request's `Authorization: Bearer` JWT and loads the user's
    current roles/permissions/branch-scope — through the SAME transaction,
    since `User`/`Role`/`Permission`/`UserBranch` are all RLS-protected.
    This was deliberate, not an accident of convenience: `tx` only exists
    inside that interceptor's call; a second global interceptor for auth
    would make "does it see `tx`" an implicit property of module import
    order rather than a guarantee. `RequestTenantStore` gained two fields
    for this: `permissions: string[] | null` and `branchIds: string[] | null`
    (see Branch scoping below) — exactly the extension 0.3 invited.
  - **Two-token model.** Access tokens are short-lived, stateless JWTs
    (`@nestjs/jwt`, `JWT_SECRET`/`JWT_EXPIRES_IN`) carrying only
    `{ sub: userId, tenantId }` — deliberately NOT roles/permissions, so a
    permission/role change takes effect on the very next request instead of
    waiting out the token's TTL; `TenantScopeInterceptor` loads them fresh
    from the DB every time instead. Refresh tokens are opaque random ids
    tracked in Redis (`TokenService`, `JWT_REFRESH_EXPIRES_IN`), one record
    per token at `auth:rt:<tokenId>`, because they need to be individually
    revocable and rotation-tracked — a JWT refresh token would just be a
    stateless wrapper around state we have to keep in Redis anyway.
  - **Refresh rotation + reuse detection.** Every refresh both invalidates
    the presented token and issues a new one in the same "family"
    (`auth:family:<familyId>`, one per login/session). A rotated-away
    token's record isn't deleted — it's flagged `used: true` and kept until
    its original TTL lapses, as a tombstone. Presenting it again (the
    signature of a leaked/stolen refresh token — a legitimate client would
    never do this) revokes the ENTIRE family, not just that token, and
    emits `auth.refresh_reuse_detected`. A token with no record at all
    (never issued, or already fully expired/revoked) is just an ordinary
    401, not a reuse signal. `logout` revokes one family (the session tied
    to the presented refresh token); `logout-all` revokes every family for
    the user (`auth:userfamilies:<tenantId>:<userId>`).
  - **`@AllowAnonymous()` vs `@Public()`** — two different decorators for
    two different exemptions, both in the pipeline above:
    `@Public()` (0.3) skips tenant resolution entirely (health checks —
    there's no tenant to bind to). `@AllowAnonymous()` (0.4) still resolves
    the tenant and opens its transaction, it just skips the JWT check —
    login/refresh/request-password-reset/reset-password need a tenant to
    scope the user lookup to, they just don't have a token yet (that's what
    they're for).
  - **RBAC is deny-by-default, DB-backed, not enum-backed.** `Role` and
    `Permission` are ordinary tenant-scoped tables (RLS applies to both,
    same pattern as every other 0.2 table) — `packages/shared`'s
    `PERMISSIONS`/`SYSTEM_ROLE_PERMISSIONS` constants are ONLY seed
    defaults (`packages/db/src/seed-rbac.ts`'s `seedSystemRolesAndPermissions`,
    called by `prisma/seed.ts` for the demo tenant), never read at
    enforcement time — a tenant can rename a role or edit its permission
    set with zero code change, and it takes effect on the next request.
    Seeded system roles: `TENANT_ADMIN` (all permissions), `HR_MANAGER`,
    `MANAGER`, `EMPLOYEE` (see the constants for exact defaults).
  - **`@RequirePermissions(...)` + `PermissionsGuard` — actually an
    interceptor.** Deny-by-default: missing any listed permission -> 403.
    Despite the name and `@RequirePermissions()`/`PermissionsGuard` pairing
    matching what a `CanActivate` guard would look like, `PermissionsGuard`
    implements `NestInterceptor` and is applied via
    `@UseInterceptors(PermissionsGuard)`. This is required, not stylistic:
    Nest runs ALL guards — global or route-scoped — strictly before ANY
    interceptor, with no exception, and the permission set this checks is
    loaded by `TenantScopeInterceptor` during the interceptor phase. A real
    `CanActivate` here would always see an empty permission set and always
    reject. Reference usage: `GET /auth/rbac-demo` (`role.manage`).
  - **Branch scoping** extends the same mechanism: a user with zero
    `UserBranch` rows is unrestricted (every branch in the tenant, as
    always); one or more rows limits them to exactly those. RLS has no
    per-branch concept — enforcement is an application-level filter using
    the request context's `branchIds`, layered ON TOP of tenant RLS, applied
    per-query by the handler (reference: `GET /tenancy/branches`, which
    narrows `where.id` to `branchIds` when the caller is restricted).
    `branchId` (singular) stays in the context too, as the user's first
    allowed branch, for convenience — `branchIds` is what enforcement
    should read.
  - **Field-level permissions — the reusable, declarative pattern (do not
    reinvent this per module).** A decorator ties a response-DTO field to a
    required permission; a route interceptor omits ungated fields from
    nobody, and omits gated fields (not nulls them) for anyone lacking the
    permission. Built on `class-transformer`'s native `groups` feature
    rather than hand-rolled reflection — `@Expose({ groups: [permission] })`
    already implements exactly this semantic (fields with no `groups` are
    always included; fields with `groups` are included only when a
    matching group is passed):
    ```ts
    // packages/shared: the permission catalog
    export const PERMISSIONS = { SALARY_VIEW: 'salary.view', /* ... */ } as const;

    // apps/api/src/common/permissions/requires-permission.decorator.ts
    export const RequiresPermission = (permission: PermissionKey) =>
      Expose({ groups: [permission] });

    // any future module's response DTO
    export class EmployeeResponseDto {
      id!: string;
      name!: string;

      @RequiresPermission(PERMISSIONS.SALARY_VIEW)
      salary!: number; // omitted entirely for a caller without salary.view
    }

    // the route
    @Get(':id')
    @UseInterceptors(PermissionSerializerInterceptor) // reads TenantContextService's permissions as `groups`
    async getEmployee(@Param('id') id: string): Promise<EmployeeResponseDto> {
      return new EmployeeResponseDto(await this.employees.findOne(id)); // must be a real class instance — plain objects have no gating metadata to apply
    }
    ```
    `PermissionSerializerInterceptor` (`apps/api/src/common/permissions/permission-serializer.interceptor.ts`)
    is what supplies the caller's current permission set as `groups` — apply
    it per-route, not globally, since most routes return nothing sensitive
    to gate. Reference/test endpoint: `GET /tenancy/permission-field-demo`
    (`apps/api/src/common/permissions/demo/`) — there's no real
    Employee/Payroll module yet (later phase), so this demo DTO is what
    proves and tests the pattern until one exists; copy it exactly, don't
    build a parallel mechanism.
  - **SSO seam (seam only — no real SSO yet).** `AuthService` depends on
    the `AUTH_PROVIDER` DI token (`apps/api/src/auth/providers/auth-provider.interface.ts`),
    not on a concrete implementation. `LocalAuthProvider` (email + password
    via argon2id, `@node-rs/argon2` — prebuilt native bindings, no
    node-gyp) is the only binding today
    (`{ provide: AUTH_PROVIDER, useExisting: LocalAuthProvider }` in
    `auth.module.ts`). Adding SAML/OIDC later means adding a new
    `AuthProvider` implementation and changing that one binding (eventually
    to a per-tenant-configurable selector) — `AuthService` itself shouldn't
    need to change.
  - **Audit-event emission points (wiring for 0.9, not persistence yet).**
    `AuthService`/`TokenService` emit structured `auth.*` domain events via
    `@nestjs/event-emitter` for every auth-worthy action: `auth.login`,
    `auth.login_failed`, `auth.logout`, `auth.logout_all`,
    `auth.password_changed`, `auth.password_reset_requested`,
    `auth.password_reset_completed`, `auth.refresh_reuse_detected` (see
    `apps/api/src/auth/auth-events.ts` for the full contract). Consumed
    today only by `AuditEventsListener`, which just structured-logs them —
    0.9 replaces that listener with real persistence into the (future,
    partitioned — see Tenancy model) `audit_log` table without touching
    `AuthService`. Role-change events are intentionally NOT wired yet: this
    step has no role-management endpoint (only enforcement + seeding), so
    there's nothing real to emit from — added when that endpoint lands.
  - **Security baseline**: all request bodies validated via zod schemas
    from `packages/shared` through a small `ZodValidationPipe` (the
    project's one validation paradigm end to end, not a second one
    alongside class-validator); login/refresh/reset all give the same
    generic failure message regardless of _why_ (unknown email, wrong
    password, inactive account, expired/invalid token) — no user
    enumeration; login/refresh/password-reset-request are Redis-rate-limited
    per `{tenantId, email}` (`RateLimiterService`, fixed-window `INCR`+`EXPIRE`),
    reset to zero on a successful login so legitimate rapid use isn't
    penalized by attempts that came before it succeeded; no secrets appear
    in code (JWT/DB/Redis secrets are all env-sourced, per existing
    convention).
  - Verified end-to-end over real HTTP by `apps/api/test/auth-rbac.e2e-spec.ts`
    (16 tests: login incl. no-enumeration, refresh rotation + reuse
    revoking the whole family, logout vs. logout-all, RBAC permit/deny,
    field-level include/omit, branch-scoping restricted/unrestricted,
    cross-tenant login rejection + cross-tenant token replay rejection +
    RLS still holding, rate-limit 429) plus `apps/api/test/tenant-resolution.e2e-spec.ts`
    (0.3's suite, updated to authenticate now that `/tenancy/*` correctly
    requires it).
- **Licensing / feature flags** (defined in step 0.6 — `packages/db`,
  `packages/shared`, `apps/api/src/licensing`):
  - **Editions → flags.** `TenantEdition` (STARTER/PROFESSIONAL/ENTERPRISE,
    from 0.2) gates a set of feature flags via `packages/shared`'s
    `EDITION_FEATURES` — a pure code constant (product/pricing decision,
    not tenant-editable data, unlike RBAC's `PERMISSIONS`/
    `SYSTEM_ROLE_PERMISSIONS`, which are only DB-seed defaults). List every
    flag an edition should have explicitly rather than relying on
    inheritance — ENTERPRISE ⊇ PROFESSIONAL ⊇ STARTER by convention, not by
    structure, so a deliberate exception is a one-line diff. The catalog
    (`FEATURE_FLAGS`) today: `advanced_reporting`, `custom_roles`,
    `api_access` (PROFESSIONAL+), `sso`, `multi_country_payroll`,
    `custom_workflows`, `audit_log_export` (ENTERPRISE only).
  - **`@RequireFeature(...flags)` + `FeatureFlagGuard`.** Deny-by-default,
    identical shape to `@RequirePermissions()` + `PermissionsGuard`
    (applied via `@UseInterceptors()` despite the name, for the same
    "guards run before any interceptor, but this needs `tx`" reason — see
    RBAC above). Unlike `PermissionsGuard`, it queries
    `FeatureFlagResolutionService` fresh on every gated request rather
    than reading a value `TenantScopeInterceptor` precomputed — entitlement
    resolution is comparatively rare (only `@RequireFeature` routes pay for
    it) and, in lifetime mode, MUST be fresh every time (see below), not
    cached in the request context the way permissions are. Usage:
    ```ts
    @Get('reports/advanced')
    @UseInterceptors(FeatureFlagGuard)
    @RequireFeature(FEATURE_FLAGS.ADVANCED_REPORTING)
    getAdvancedReport() { /* ... */ }
    ```
    Reference/test endpoint: `GET /licensing/demo/advanced-reporting`.
  - **Two delivery modes, one resolution service.** `LICENSE_MODE`
    (`saas` | `lifetime`) picks which BASE entitlement
    `FeatureFlagResolutionService.resolve(tx, tenantId)` computes before
    layering `TenantFeatureFlagOverride` rows on top (see below) — same
    function, same override step, either mode:
    1. **SaaS** (`LICENSE_MODE=saas`, the default) — reads the tenant's
       `Subscription` row. `Subscription.edition` (NOT `Tenant.edition`)
       is what's read here: a subscription's plan is what a real billing
       system (Stripe integration is Phase 4.2 — this step is explicitly a
       stub for that) naturally attaches edition/seat data to, and one
       field as the single source of truth avoids two columns drifting out
       of sync. `Tenant.edition` keeps its original 0.2 display/legacy
       role. A `TRIAL`/`ACTIVE` subscription resolves
       `EDITION_FEATURES[subscription.edition]`; `PAST_DUE`/`CANCELED` (or
       no subscription row at all) resolves an EMPTY flag set — this is
       what makes `@RequireFeature` return 403 the moment a subscription
       lapses.
    2. **Lifetime/on-prem** (`LICENSE_MODE=lifetime`) — reads the tenant's
       ACTIVE `License` row's signed payload, RE-VERIFIED against the
       RS256 public key on THIS call, every call — never trusted from the
       DB snapshot alone. This is what satisfies "verify on boot and
       periodically" from this step's brief without a separate scheduler:
       every entitlement check already re-verifies fresh against the
       current key and the current clock, which is strictly stronger than
       a periodic timer. A missing license, or one that fails
       re-verification (tampered, expired, wrong key), resolves an EMPTY
       flag set.
  - **License file format & the key-handling rule (SECURITY BOUNDARY).** A
    license file is an RS256-signed, JWT-shaped token. Custom claims
    (`packages/shared`'s `licensePayloadSchema`): `tenantId`, `tenantName`,
    `edition`, `enabledFlags`, `seatCap`, and an optional `challenge` (see
    Offline activation below) — plus the JWT's OWN standard `iat`/`exp`
    claims for issue date/expiry, not duplicated as custom fields. No
    `exp` claim at all = perpetual license (`jsonwebtoken` only adds `exp`
    when `expiresIn` was passed at signing). **The PRIVATE signing key
    must never ship in an on-prem build — only the PUBLIC key does.**
    Enforced structurally, not just by convention: `LicenseSigningService`
    (signing, needs the private key) and `LicenseVerificationService`
    (verification, needs only the public key) are separate classes, and
    the private key is read lazily from `LICENSE_PRIVATE_KEY_PATH` only
    when `sign()` is actually called — a deployment that simply doesn't
    have that file can still verify licenses (everything lifetime-mode
    resolution needs) without ever successfully signing one. Both services
    use `@nestjs/jwt`'s `JwtService` instantiated directly (not the
    app-wide HS256-configured `JwtModule` used for access tokens), with
    the RS256 key supplied per call via `privateKey`/`publicKey` options —
    the same "mint a token directly" pattern this codebase's own e2e tests
    already use. See `apps/api/keys/README.md` for the full operational
    rule and how to regenerate the local dev keypair (`license-public-dev.pem`
    committed, `license-private-dev.pem` gitignored via `.gitignore`'s
    `apps/api/keys/*private*.pem`).
  - **Offline activation via challenge-response** (for air-gapped
    lifetime/on-prem installs): `LicenseActivationService` (tenant-scoped,
    the CUSTOMER instance's own side) vs. `LicensingAdminService`
    (platform-scoped, the VENDOR's side — see Platform context below).
    1. The on-prem instance calls `POST /licensing/activation/challenge`,
       which mints a random nonce and stores it in Redis
       (`license:activation-challenge:<tenantId>`, 30-minute TTL — same
       "opaque, short-lived, per-tenant token" shape `TokenService`/
       `RateLimiterService` already use, not a DB table, since it's
       transient by nature). The operator relays this nonce to the vendor
       out-of-band (email, a portal upload — however an air-gapped
       customer reaches the vendor).
    2. The vendor's `POST /platform/licensing/issue` embeds that nonce as
       the license payload's `challenge` claim when issuing.
    3. The on-prem instance calls `POST /licensing/activation/complete`
       with the resulting file. If a challenge is currently pending for
       that tenant, the file's `challenge` claim MUST match it (proving
       this specific file answers this specific request, not a replay
       against a different install) or activation is rejected — the
       pending challenge is deleted on a successful match. A DIRECT/online
       activation (no challenge ever requested) skips this check entirely
       — signature + expiry + tenant-id match are enough.
       Activating supersedes any prior ACTIVE `License` row for the tenant
       (moved to `SUPERSEDED`, kept for audit — never deleted).
  - **Seat-cap enforcement differs DELIBERATELY by mode** (`SeatCapService`,
    comparing `tx.user.count({where:{status:'ACTIVE'}})` — RLS-scoped, so
    no explicit `tenantId` filter is needed — against a cap): SaaS mode's
    `Subscription.seatCap` is nullable and, when set, over-cap is
    **flagged** (surfaced as `overCap: true` in
    `GET /licensing/entitlements`, non-blocking — a tenant's paid features
    shouldn't vanish because HR added one too many employees; that's a
    billing conversation). Lifetime mode's `License.seatCap` is always
    enforced and over-cap **blocks** — the resolved flag set is forced
    empty until seats are reconciled or a new license is activated, since
    there is no billing system on the other end to flag it to.
  - **Platform context — first real cross-tenant access through the 0.3
    seam.** `LicensingAdminController`'s three routes
    (`POST /platform/licensing/issue`, `POST /platform/licensing/revoke`,
    `PATCH /platform/licensing/flags/:tenantId`) are `@PlatformRoute()`,
    gated by `PLATFORM_MODE_ENABLED` exactly like `GET /platform/ping`
    since 0.3 — but they are the first routes to actually DO something
    cross-tenant with that seam. A platform request still opens NO
    tenant-scoped transaction (`TenantContextService.getTx()` still throws
    unconditionally there, unchanged from 0.3/0.4/0.5), so
    `LicensingAdminService` queries through `prisma` — the owner/admin
    client — directly, the same class of usage `packages/db/prisma/seed.ts`
    already makes of it. `FORCE ROW LEVEL SECURITY` on every table this
    touches means this admin path (and seeding/tests) is the ONLY way to
    cross tenant boundaries — no normal tenant request gains anything from
    this service existing. Every mutating call
    (`issue`/`revoke`/`setFlagOverride`) emits a `licensing.*` domain event
    (`licensing-events.ts`, same deferred-to-0.9-persistence pattern as
    `auth-events.ts`) — issue/revoke per this step's brief, plus
    `flag_override_set` for the same reason, and a non-mutating
    `seat_cap_exceeded` emitted from `GET /licensing/entitlements` when it
    observes `overCap: true` (the SaaS "flagged" signal made concrete,
    without spamming an event on every single gated request the way
    emitting it from `FeatureFlagGuard`'s hot path would).
  - **`TenantFeatureFlagOverride`** — the per-tenant admin lever, layered
    on top of whichever base (subscription-edition or license) the mode
    resolves: `enabled: true` grants a flag even outside the tenant's
    edition/license; `enabled: false` revokes one even inside it. Ordinary
    tenant-scoped RLS applies (reads happen inside a normal tenant
    request's transaction; writes only through the platform admin path
    above).
  - Verified end-to-end over real HTTP by
    `apps/api/test/licensing-saas.e2e-spec.ts` (10 tests: no-subscription
    blocked, ACTIVE enables edition flags, CANCELED/PAST_DUE disable them
    - 403 on the demo route, TRIAL restores them, seat-cap over-cap
      flagged-not-blocking, platform flag-override grant/revoke, unknown
      tenant 404, cross-tenant isolation) and
      `apps/api/test/licensing-lifetime.e2e-spec.ts` (11 tests: no-license
      blocked, issue+activate enables flags, tampered/expired/wrong-key/
      wrong-tenant license all rejected, seat-cap over-cap BLOCKING, the
      offline challenge-response flow succeeding and rejecting a stale-
      challenge replay, cross-tenant isolation).
- **Workflow / approval engine** (defined in step 0.7 — `packages/db`,
  `packages/shared`, `apps/api/src/workflow`):
  - **THE RULE.** There is exactly ONE approval engine in this codebase.
    Leave, expenses, regularizations, offer approvals, and anything else
    that ever needs a multi-step sign-off ALL consume
    `WorkflowEngineService`/the five routes on `WorkflowController` — no
    future module may grow its own approve/reject/delegate logic. A
    consuming module's only job is: define a `WorkflowTemplate` for its
    `entityType`, call `POST /workflow/instances` when something needs
    approval, and react to `workflow.*` events. Everything about WHO
    approves and in what order is DATA (`WorkflowStep.approverRule`/
    `condition`), never a code branch on entity type.
  - **Core model**: `WorkflowTemplate` (named, versioned, `isActive` —
    resolution picks the highest-version active template for a
    `(tenantId, entityType)`, same pattern as 0.5's `CountryPack`) owns
    ordered `WorkflowStep`s. `WorkflowInstance` is the POLYMORPHIC running
    approval (`entityType` + `entityId`, no FK to the owning module's
    table — deliberately, since it usually doesn't exist yet and never
    should be a hard dependency of the generic engine) with a
    `dataSnapshot` (JSON, e.g. `{ amount, days, leaveType }`) captured
    ONCE at submission and never re-read from the source module —
    conditions/auto-approval/escalation all evaluate against this frozen
    copy, so an approval in flight is unaffected by the source record
    changing underneath it. `WorkflowInstanceStep` is the per-instance
    MATERIALIZATION of each template step (one row per template step,
    including `SKIPPED` ones — see Conditional branching below) — this is
    what lets one template be reused across many instances while each
    tracks its own resolved approvers/progress independently, and is the
    audit-friendly record of "which steps actually applied to THIS
    request and why". `WorkflowAction` is the append-only, never-updated
    audit trail: one row per approve/reject/delegate/comment/escalate/
    auto-approve/cancel, who (null for the two system-initiated types)
    and when.
  - **Sequential vs. parallel — one `order` column.** Steps sharing the
    same `order` within a template are a PARALLEL group: ALL of them must
    reach `APPROVED` before the instance advances past that `order`;
    different `order` values run SEQUENTIALLY.
    `WorkflowEngineService.activateNextGroup` (private) is the only place
    that decides "what's next" — it looks at the lowest `order` among
    still-`PENDING` (non-skipped, non-yet-activated) instance steps,
    activates every step in that group, and recurses immediately if the
    whole group turns out to auto-approve (see below) so a chain that
    needs no human at all resolves straight through in one call. No
    `PENDING` steps left at all -> the instance is `APPROVED`.
  - **Approver rules — resolved by RULE, never a fixed user**
    (`ApproverRule`, `packages/shared/src/validators/workflow.validator.ts`;
    resolved by `apps/api/src/workflow/approver-resolver.service.ts`):
    `SPECIFIC_USER` (a literal user id), `ROLE` (any `ACTIVE` user holding
    that role name in the tenant — reads the live `Role`/`UserRole` rows,
    same DB-backed-not-enum-backed posture as RBAC itself), `MANAGER`,
    `BRANCH_HEAD`, `DEPARTMENT_HEAD`, and `CONDITIONAL` (picks between two
    entirely different sub-rules based on a `WorkflowCondition` evaluated
    against the instance's `dataSnapshot` — e.g. "route to the CFO if
    amount > threshold, else the finance manager"; a DIFFERENT mechanism
    from a step's own `condition` field, which decides whether a step
    exists in the chain at all, not who approves an existing one).
    **`MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD` are PLUGGABLE SEAMS**,
    not real Employee-module data (phase 1.1 doesn't exist yet):
    - `MANAGER` resolves against `User.managerId` — a new nullable
      self-relation column added to `User` this step specifically so this
      rule has something to resolve against (same composite-self-relation-FK
      pattern as `Branch.parentBranchId`/`Department.parentDepartmentId`).
    - `BRANCH_HEAD`/`DEPARTMENT_HEAD` resolve against new nullable
      `Branch.headUserId`/`Department.headUserId` columns (composite FK to
      `User`, same pattern), and need to know WHICH branch/department the
      request is even about — `dataSnapshot.branchId`/`.departmentId` wins
      if the submitting module supplies one; failing that, `BRANCH_HEAD`
      falls back to the requester's sole `UserBranch` row if exactly one
      exists (there is no "requester's department" data source at all yet,
      so `DEPARTMENT_HEAD` has no fallback).
      When the real Employee module lands, only
      `ApproverResolverService`'s few private helper methods should need to
      change to query real employee data — the `ApproverRule` type, the
      engine's state machine, and every other rule kind are unaffected.
  - **Conditional branching reuses 0.5's rules-engine APPROACH, not its
    file** (this step does not modify `packages/db/src/country-packs/`
    or `packages/shared/src/validators/rules-engine.validator.ts` — see
    the header comment of `packages/shared/src/validators/workflow.validator.ts`
    for the full reasoning). Reused literally: `ALLOWED_EXPR_OPERATORS`
    (imported, not redefined) and — the important part — the SECURITY
    PATTERN: a fixed, closed JSON AST (`WorkflowValueExpr`, structurally
    identical to 0.5's `Expr`) interpreted structurally by
    `apps/api/src/workflow/condition-evaluator.ts`, never a string parsed
    or `eval`'d. What's NEW, and why a second schema is not "a second
    UNSAFE evaluator": (1) variable names are OPEN (`z.string()`), not
    0.5's closed payroll-specific enum — the workflow `dataSnapshot` is
    intentionally polymorphic per consuming module, and the safety
    property still holds structurally, since the evaluator only ever does
    a typed lookup on an object THIS code populated, never arbitrary
    property access on untrusted input; (2) a BOOLEAN layer
    (`WorkflowCondition`: `compare`/`and`/`or`/`not`) sits on top of the
    arithmetic layer, because 0.5 only ever needed to compute a NUMBER
    (a tax amount) and a workflow condition is inherently a yes/no
    decision — arithmetic alone can't express "amount > threshold".
    Numeric comparisons only (no string equality) — a deliberate,
    documented scope boundary, extend it deliberately if a real module
    ever needs one, don't work around it elsewhere. A step's `condition`
    (gates whether the step applies to THIS instance at all — the
    "amount > threshold requires an extra step" mechanism) and
    `autoApproveCondition` (gates whether the step needs a human at all)
    are both `WorkflowCondition`, evaluated once at instance-creation
    (`condition`, baked into whether the instance step is created as
    `PENDING` or `SKIPPED`) or once at step-activation
    (`autoApproveCondition`) respectively — re-validated against the
    shared schema on read, same "JSON column has no guarantee of its own"
    posture as every other JSON-configured feature in this codebase.
  - **Delegation and escalation both REASSIGN (replace), not add.** Once
    `WorkflowInstanceStep.delegatedToUserId` is set (via a `DELEGATE`
    action from a currently-eligible approver, to any other `ACTIVE`
    tenant user), ONLY that user may act on the step — not the original
    approver(s), not even the delegator. Escalation (fired by
    `WorkflowEscalationService.sweepOverdueSteps()` for any `ACTIVE` step
    past its `dueAt`, resolving the template step's `escalationRule`) sets
    `escalatedToUserId` the same way, with the same replace semantics —
    picked for one consistent mental model and so both are equally easy
    to test ("delegation/escalation reassigns" means exactly that, not
    "adds a second possible approver"). `actOnStep`'s eligibility check is
    `delegatedToUserId` if set, else `escalatedToUserId` if set, else the
    step's `eligibleApproverIds` snapshot.
  - **The escalation sweep is a cross-tenant system operation, called
    directly (no scheduler wired yet).**
    `WorkflowEscalationService.sweepOverdueSteps()` discovers overdue
    steps across EVERY tenant via `prisma` (the owner/admin client — the
    same class of cross-tenant use `LicensingAdminService` already makes
    of it, see Licensing / feature flags → Platform context above), then
    performs each actual escalation write inside a proper
    `withTenantContext` transaction for that step's own tenant, so RLS is
    enforced for the mutation exactly as everywhere else. Not wired to a
    real cron/BullMQ job — that's scheduling infrastructure out of this
    step's scope (0.8's notification hub, or a future scheduled job, can
    call this method directly); it's safe to call repeatedly/concurrently
    (`escalatedToUserId IS NULL` in the discovery filter, plus a re-check
    inside `escalateStep`, means an already-escalated step is never
    escalated twice).
  - **Auto-approval** (`WorkflowStep.autoApproveCondition`): when a step
    activates and this evaluates true against the instance's
    `dataSnapshot`, the step resolves straight to `APPROVED` with a
    `WorkflowAction` of type `AUTO_APPROVE` (`actorUserId: null`) — no
    human ever sees it. A DIFFERENT mechanism from `condition` (which
    decides whether the step exists in the chain at all): here the step
    exists, it just needs nobody to click anything.
  - **Rejection is fail-fast; a canceled/rejected instance's still-`ACTIVE`
    steps are frozen, not rewritten.** Any `REJECT` on any step
    (sequential or one of several parallel siblings) immediately
    finalizes the WHOLE instance as `REJECTED` — siblings that hadn't
    been decided yet keep whatever status they were last in; the
    instance's own terminal `status` is what `actOnStep` actually checks
    before accepting any further action, so a stale-looking sibling step
    can never be acted on again regardless. `cancelInstance` (the
    requester, or a `workflow.manage` holder) behaves the same way.
  - **Events, wired now for 0.8/0.9 to consume later**
    (`apps/api/src/workflow/workflow-events.ts`, same deferred-persistence
    pattern as `auth-events.ts`/`licensing-events.ts`): `workflow.submitted`,
    `workflow.step_approved` (every individual step decision, human or
    auto), `workflow.approved`, `workflow.rejected`, `workflow.escalated`,
    plus `workflow.delegated` and `workflow.canceled` (both clearly
    "state changes" per this step's brief, even though not in its
    named-example list) — consumed today only by
    `WorkflowEventsListener`, which just logs them.
  - **API surface is exactly five generic routes**
    (`apps/api/src/workflow/workflow.controller.ts`): `POST
/workflow/instances` (start — defaults `requesterId` to the caller;
    submitting on someone else's behalf needs `workflow.manage`),
    `GET /workflow/instances/:id` (status/history — instance + steps +
    actions), `POST /workflow/instances/:id/steps/:stepId/actions`
    (approve/reject/delegate/comment), `POST /workflow/instances/:id/cancel`,
    `GET /workflow/my-pending-approvals`. Deliberately no template-authoring
    endpoint this step — templates/steps are created directly via the
    owner `prisma` client (seeding/fixtures), the same way RBAC roles,
    country packs, and licenses are all set up elsewhere in this codebase
    before/without a dedicated admin UI; add one only when a real need
    for tenant-side template editing shows up.
  - **Two authorization layers, same shape as branch scoping.**
    `workflow.participate` (granted to every seeded system role) is the
    coarse RBAC gate — "may use the workflow system at all"; a NEW
    `PERMISSIONS.WORKFLOW_MANAGE` (`TENANT_ADMIN` implicitly, `HR_MANAGER`
    explicitly) is required to start an instance on someone else's behalf
    or cancel someone else's instance. WHICH specific instances/steps a
    caller may act on is a separate, row-level check the service layer
    enforces (standing on an instance = requester, an eligible approver
    on any of its steps, or `workflow.manage`; eligibility on a step = in
    its current `eligibleApproverIds`/`delegatedToUserId`/
    `escalatedToUserId`) — RBAC permission gates the FEATURE, the service
    layer gates the ROW, exactly the two-layer shape 0.4's branch scoping
    established on top of tenant RLS.
  - **Known scaling tradeoff**: `myPendingApprovals` fetches every
    tenant-wide `ACTIVE` instance step and filters eligibility in
    application code rather than pushing the "is this user in this JSON
    array" check into the SQL query — simpler and unambiguously correct
    today; worth revisiting (e.g. a dedicated eligibility join table) if
    per-tenant instance-step volume ever makes this a real cost, same
    "documented, not silently accepted" posture as 0.3's held-open-
    transaction tradeoff.
  - Verified end-to-end over real HTTP by `apps/api/test/workflow.e2e-spec.ts`
    (12 tests: a sequential leave-style flow manager -> HR run to
    completion, a conditional expense-style flow both skipping and adding
    its HR step by amount, a parallel step blocked until both approvers
    act, delegation reassigning who may approve, escalation firing on a
    simulated timeout and reassigning the same way, auto-approval with no
    human action, rejection terminating the whole instance, cancellation
    blocking further action, deny-by-default cancel by a non-requester,
    and cross-tenant isolation on both template resolution and instance
    visibility) plus `apps/api/src/workflow/condition-evaluator.spec.ts`
    (14 unit tests: arithmetic/comparison/boolean-combinator correctness
    and the sandbox rejecting every out-of-whitelist shape).
- **Notifications hub** (defined in step 0.8 — `packages/db`,
  `packages/shared`, `apps/api/src/notifications`, `apps/api/src/queue`):
  the delivery layer every domain event emitted since 0.4 (auth), 0.6
  (licensing), and 0.7 (workflow) has been waiting for — none of those
  emitters changed to make this work (beyond auth's password-reset event
  gaining a `token` field, see below); this hub just started listening to
  the SAME `auth.*`/`licensing.*`/`workflow.*` events
  `AuditEventsListener`/`LicensingEventsListener`/`WorkflowEventsListener`
  already consumed.
  - **Core model, echoing 0.7's logical/per-unit-of-work split**:
    `Notification` (one row per notification generated for one recipient
    from one domain event — channel-agnostic, holds the triggering event's
    `payload` for re-rendering) → `NotificationDelivery` (one row per
    CHANNEL that notification goes out on — `PENDING`/`SENT`/`FAILED`/
    `DEAD_LETTER`, `attempts`/`lastError`, `renderedSubject`/
    `renderedBody` captured at send time, `readAt` meaningful only for
    `IN_APP`). Both tenant-scoped, ordinary RLS. `NotificationPreference`
    (tenant-scoped, `@@unique([tenantId, userId, eventType, channel])`) is
    the per-user opt-in/opt-out layer. `NotificationTemplate` is
    deliberately NOT tenant-scoped — global, versioned, `isActive` vendor
    copy keyed by `(eventType, channel, locale, version)`, the exact same
    RLS-exempt "system-owned reference data" shape as `CountryPack` (0.5),
    for the same reason (it's vendor-authored, not per-tenant).
  - **Async delivery is the whole point (BullMQ) — THE REUSABLE PATTERN.**
    `apps/api/src/queue/queue.module.ts` (`QueueModule`, `@Global()`) is
    the first queue infrastructure in this system and is written to be
    reused as-is by later heavy jobs (payroll runs, report generation,
    bulk imports — see that file's doc comment for the exact two-line
    recipe: `imports: [BullModule.registerQueue({name:'x'})]` +
    a `@Processor('x')` class extending `WorkerHost`). It owns exactly one
    thing: `BullModule.forRootAsync`'s shared connection OPTIONS
    (`host`/`port`/`password` parsed from `REDIS_URL`, `maxRetriesPerRequest:
null` — BullMQ's own documented requirement for a Worker connection).
    **Deliberately plain connection OPTIONS, not a hand-constructed
    `ioredis` instance**: given options, BullMQ opens and OWNS every
    Queue/Worker/QueueEvents connection itself, so `app.close()`'s normal
    NestJS shutdown lifecycle (`onApplicationShutdown`) closes them all
    automatically — a hand-shared external client is NOT reliably closed
    the same way (verified while building this step: it caused every e2e
    test's `app.close()` to leave a dangling handle and hang). This is a
    SEPARATE physical connection pool from `RedisModule`'s `REDIS_CLIENT`
    (refresh tokens / rate limiting), which must NOT set
    `maxRetriesPerRequest: null` — the two are deliberately not shared.
    `NotificationsModule` registers the `notifications` queue and its
    `NotificationProcessor` (`@Processor`, extends `WorkerHost`) as the
    worked example.
  - **Producer/consumer split.** `NotificationsService.handleDomainEvent`
    (producer) resolves recipients, filters by preference, creates the
    `Notification`/`NotificationDelivery` rows, THEN enqueues one BullMQ
    job per delivery — enqueuing only after its own `withTenantContext`
    transaction commits, so a job can never reference a row from a
    transaction that could still roll back. `NotificationDeliveryService`
    (consumer, called by `NotificationProcessor.process`) does the actual
    per-channel work: resolve locale, render the template, call the
    provider (skipped for `IN_APP` — the `NotificationDelivery` row itself
    IS the in-app notification), record the result. **This is what
    satisfies "a slow/failing provider must never block or hang the API
    request that triggered it"**: nothing on either side of this split
    ever executes on the triggering request's call stack, and nothing
    about it is `await`ed by that request — proven by
    `apps/api/test/notifications.e2e-spec.ts`'s async-delivery test, which
    overrides `EMAIL_PROVIDER` with an artificially slow implementation
    and asserts the HTTP response returns in well under the provider's
    delay, then that delivery still completes shortly after.
  - **Retry + dead-letter.** `NotificationsService`'s job options set
    `attempts: 5` with exponential backoff. On failure,
    `NotificationDeliveryService.deliver` ALWAYS records
    `attempts`/`lastError`; if this was NOT the job's final BullMQ
    attempt it re-throws (BullMQ retries per the backoff), and on the
    FINAL attempt it records `DEAD_LETTER` and does NOT re-throw — BullMQ's
    open-source tier has no separate dead-letter QUEUE primitive, so
    "permanently failed, no further retry" is expressed as durable
    `NotificationDelivery.status` instead of a second physical queue. Uses
    THREE separate `withTenantContext` transactions (read → render+send →
    write final status) rather than one wrapping the whole method,
    specifically so the failure-recording write is never rolled back by
    the same re-throw that triggers the BullMQ retry.
  - **Provider seam — swappable per channel, same shape as 0.4's SSO
    seam.** `NotificationProvider` (`@hrm/shared`, `send(params):
Promise<void>`) is bound per channel behind a DI token
    (`EMAIL_PROVIDER`/`SMS_PROVIDER`/`PUSH_PROVIDER`,
    `apps/api/src/notifications/providers/`); today all three bind to
    `LogXxxProvider` (log the rendered message, dev/no-op — matching this
    codebase's existing "log in dev, real integration is later work"
    posture, e.g. 0.4's original password-reset stub, which this hub now
    supersedes). Swapping in Amazon SES / Twilio / FCM later is changing
    ONE binding in `notifications.module.ts`, exactly like 0.4's
    `{provide: AUTH_PROVIDER, useExisting: LocalAuthProvider}` — no caller
    changes. A local-SMTP-catcher (Mailhog) dev provider is an equally
    valid drop-in but wasn't built this step — it would need a Mailhog
    container wired into `docker-compose.yml` and CI, out of scope for
    proving the abstraction itself, which the log provider already does.
    `IN_APP` has no provider — persisting the row IS the delivery.
    Neither SMS nor PUSH has a real destination field on `User` yet (no
    phone number / device token — that belongs to a future Employee/
    profile module); the dev providers log the recipient's userId as a
    placeholder `to`, documented at each provider as a seam a real
    provider will resolve properly.
  - **Templates + i18n.** "Externalize all template strings" means
    `NotificationTemplate` rows (seeded from
    `packages/db/src/seed-notification-templates.ts`, the same
    seeded-but-DB-stored pattern `seed-country-packs.ts` established) are
    the ONLY place any notification copy is written — no hardcoded English
    (or Arabic) string exists anywhere in `apps/api`'s rendering code.
    `NotificationTemplateRenderer` loads the highest-version active
    template for `(eventType, channel, locale)`, falling back to `"en"` if
    the recipient's exact language has no template, then substitutes
    `{{placeholder}}` tokens from the triggering event's payload via a
    plain regex — safe with no sandboxing needed (unlike 0.5's/0.7's
    expression evaluators) because templates are vendor-authored data, not
    tenant- or user-submitted input; there is no tenant-override layer for
    templates in this step. No template for EITHER the exact locale or the
    `"en"` fallback is a loud `NotFoundException` (this project's
    consistent "no `missing_ok`" posture), which surfaces inside the
    worker as a job failure — retried, then dead-lettered — rather than a
    silently blank notification.
  - **Recipient locale resolution** (`NotificationLocaleResolverService`):
    `User.preferredLanguage` (new nullable column, this step) wins if set
    (its `rtl` is then derived from a small explicit whitelist,
    `@hrm/shared`'s `isRtlLanguage` — `ar`/`he`/`fa`/`ur` — since the
    recipient's resolved branch's Country Pack no longer necessarily
    matches a language they've explicitly overridden to); otherwise falls
    back to the Country Pack `locale.defaultLanguage`/`locale.rtl`
    resolved for the recipient's first `UserBranch`, or the tenant's
    `defaultCountryCode` if the recipient has no branch at all. **Does NOT
    reuse `CountryPackResolutionService`** — that service reads
    `TenantContextService.getTx()`/`.tenantId` internally, which only
    exist inside a request's `AsyncLocalStorage` context, and this runs
    from the notification worker, outside any request, with only an
    explicit `tx` (same constraint `ApproverResolverService`/
    `WorkflowEscalationService` already established in 0.7). The two small
    lookup queries are duplicated with an explicit-`tx` signature rather
    than touching `country-packs/`; the actual pack/override MERGE logic
    (`mergeCountryPackConfig`) is reused as-is, since it's a plain function
    with no request-context dependency — the two-layer override model
    itself can never drift between request-time resolution and this one.
    Verified by
    `apps/api/src/notifications/notification-locale-resolver.service.spec.ts`
    (a US-branch recipient resolves en/LTR, a Qatar-branch recipient
    resolves ar/RTL, and a `preferredLanguage` override on a US-branch
    user flips both independently of their branch) and by the e2e suite's
    rendered-body assertions (the same `auth.password_reset_requested`
    event renders in English for a US-branch recipient and in Arabic for a
    Qatar-branch recipient, through the real HTTP + async pipeline).
  - **Event -> notification mapping layer — pure data, plus a resolver for
    the part that isn't.** `@hrm/shared`'s `NOTIFICATION_EVENT_TYPES` /
    `DEFAULT_NOTIFICATION_CHANNELS` is pure data (which of the EXISTING
    emitted event names map to a notification, and its default channels)
    with no DB dependency, so it lives in `packages/shared`; an event name
    absent from this list is simply not mapped — no per-event-type
    listener code needed to add one later, just a data-table entry (plus a
    template and a recipient-resolver case, see below).
    `NotificationRecipientResolverService` (`apps/api`, needs a DB query,
    so it can't be pure data) is the one switch statement mapping each of
    the 7 mapped event types to WHO receives it:
    `auth.password_reset_requested` -> the user directly named in the
    event payload; `workflow.submitted` -> the current `ACTIVE` step's
    eligible/delegated/escalated approver(s); `workflow.approved`/
    `workflow.rejected` -> the instance's requester;
    `workflow.escalated` -> the payload's `escalatedToUserId`;
    `licensing.issued`/`licensing.revoked` -> every `ACTIVE` user holding
    `TENANT_ADMIN` in that tenant. An event type resolving to zero
    recipients is a legitimate terminal state (e.g. a licensing event with
    no admins), not an error.
  - **THE RACE, and the bounded retry around it.** Every existing emitter
    calls `eventEmitter.emit(...)` synchronously from INSIDE its own
    still-open request transaction — sometimes before that transaction has
    finished doing everything the event describes (`WorkflowEngineService.
startInstance` emits `workflow.submitted` before it activates the first
    step and resolves `eligibleApproverIds` — deliberately unchanged by
    this step, see Scope below). `NotificationDispatchListener`'s dispatch
    runs fire-and-forget in ITS OWN separate Postgres transaction, which
    cannot see the emitting request's writes until that request's
    transaction commits — a recipient resolver reading such
    just-written-but-not-yet-committed state can race and see nothing.
    Rather than requiring every recipient resolver to defensively retry
    internally, `NotificationsService.handleDomainEvent` gives the WHOLE
    resolve-and-create step a few short bounded retries
    (`EMPTY_RECIPIENTS_RETRY_DELAYS_MS`: 50/100/200/400/800ms) whenever it
    finds ZERO recipients, before giving up — resolves in practice on the
    first or second retry since the source transaction is typically only
    a few local writes away from committing, and harmlessly exhausts for a
    genuinely-empty recipient list (rare) at the cost of under two seconds
    of extra background latency nothing user-facing waits on.
  - **Preferences.** Absence of a `NotificationPreference` row for
    `(userId, eventType, channel)` means "use the default"
    (`DEFAULT_NOTIFICATION_CHANNELS[eventType]`); a row, when present,
    always wins in either direction (suppress a default-on channel, or opt
    into a default-off one). `NotificationPreferenceService.
resolveEnabledChannels` is the one place this is resolved; no caller
    should re-derive it.
  - **Password reset now routes through the hub (the required first real
    consumer).** `AuthService.requestPasswordReset` is UNCHANGED beyond
    one thing: the token it already generates and stores in Redis is now
    also attached to the `auth.password_reset_requested` event payload
    (`AuthEventPayload.token`, new, optional) instead of being logged
    directly by a dev-only `if (NODE_ENV !== 'production')` stub, which is
    deleted. `NotificationDispatchListener` picks the event up like any
    other mapped event — no special-casing. **`token` is SENSITIVE** (a
    live credential-reset secret) and is also visible to
    `AuditEventsListener`'s existing structured-log placeholder via the
    same `auth.*` wildcard subscription; this is documented at the field
    itself as a MUST-redact-before-persisting flag for 0.9's real audit
    log, not a gap introduced silently.
  - **API surface** (`apps/api/src/notifications/notifications.controller.ts`):
    four routes, every one implicitly scoped to the caller's own
    `userId` — there is no route to read or act on another user's
    notifications, the same "inherently self-scoped, no RBAC gate needed"
    posture `/auth/me` already has. `GET /notifications` (the caller's own
    `IN_APP` deliveries, newest first), `POST /notifications/:deliveryId/read`
    (mark-read; 404s for a channel other than `IN_APP`, someone else's
    delivery, or — the RLS proof — a delivery belonging to a different
    tenant entirely, since the lookup runs through the caller's own
    RLS-scoped transaction), `GET`/`PUT /notifications/preferences`.
  - **Scope discipline.** No existing emitter's core logic changed —
    `WorkflowEngineService`, `LicensingAdminService`, `AuthService`'s
    login/refresh/logout/change-password paths, RLS policies, and
    country-pack resolution are all untouched. `packages/db` gained one
    new nullable column (`User.preferredLanguage`) alongside the four new
    notification tables — the same "small nullable seam column" pattern
    0.7 used for `User.managerId`/`Branch.headUserId`/
    `Department.headUserId`.
  - Verified end-to-end over real HTTP by
    `apps/api/test/notifications.e2e-spec.ts` (password reset routing
    through the hub with correct per-recipient locale (English for a
    US-branch recipient, Arabic for a Qatar-branch recipient), async
    delivery decoupled from the triggering request via an artificially
    slowed provider, a per-user preference suppressing the EMAIL channel
    while `IN_APP` still delivers, a `workflow.submitted` event producing
    an in-app notification the eligible approver can list and mark-read
    with cross-tenant access rejected, and the retry-then-dead-letter
    state transition called directly against a deliberately unrenderable
    delivery) plus
    `apps/api/src/notifications/notification-locale-resolver.service.spec.ts`
    (3 tests, see Recipient locale resolution above). One benign,
    non-failing artifact of running the full suite together: a
    `workflow.submitted` event fired by `workflow.e2e-spec.ts`'s OWN
    fixtures can, on rare timing, have its fire-and-forget dispatch land
    after that file's `afterAll` has already deleted its tenant, logging
    a caught foreign-key error from `NotificationDispatchListener` — this
    is purely a test-teardown ordering artifact between two independent
    e2e files sharing one process's event bus, not a production concern
    (nothing tears down a real tenant milliseconds after emitting an
    event), and it never affected a test assertion or outcome.

## 5. Build log (append-only)

Append a new entry every time a step from the checklist below lands. Never
edit or delete a prior entry — if something is superseded, say so in a new
entry instead.

- **0.1 monorepo scaffold — done.** Turborepo + pnpm workspace with
  `apps/{api,admin,portal}` and `packages/{db,shared,config}`. Strict
  TypeScript, ESLint, Prettier, Husky pre-commit + commitlint wired up.
  `docker-compose.yml` for Postgres 16 + Redis + MinIO. `.env.example` per
  app/package. Prisma schema currently holds only a placeholder `Tenant`
  model, superseded by step 0.2.
- **0.1 verified — 2026-08-24.** `pnpm install` and `pnpm build` both pass
  cleanly from a fresh clone (all 6 workspaces: `@hrm/shared`, `@hrm/db`,
  `@hrm/api`, `@hrm/admin`, `@hrm/portal`, `@hrm/config`). `pnpm lint` passes
  across all workspaces. `docker-compose.yml` validated with `docker compose
config`. Note for future work: ESLint's shareable-config name resolution
  mangles scoped-package subpaths (e.g. `@hrm/config/eslint-preset.js` in an
  `extends` array) — every `.eslintrc.js` that extends the shared preset must
  use `require.resolve('@hrm/config/eslint-preset.js')` instead of the bare
  specifier.
- **0.2 tenancy model / Row-Level Security — done — 2026-08-24.** Entities:
  `Tenant`, `Branch` (self-relation for hierarchy, branch-level
  `countryCode`), `Department` (self-relation, belongs to a `Branch`),
  `Designation`, `CostCenter`, `User` (per-tenant-unique `email`). Every
  table but `Tenant` carries `tenantId` (native `uuid`), a composite index
  leading with `tenantId`, and — for self-relations — a composite FK back to
  `(tenantId, id)` so a row's parent can never belong to a different tenant.
  RLS enabled via hand-written SQL (`tenant_id = current_setting('app.current_tenant')::uuid`,
  on both `USING` and `WITH CHECK`, `FORCE`d on every tenant-scoped table)
  against a new non-superuser `hrm_app` role — see § Conventions → Tenancy
  model above for the full design and why two DB roles are required for RLS
  to actually take effect. Files:
  - `packages/db/prisma/schema.prisma` — the data model.
  - `packages/db/prisma/migrations/20260824093734_init_tenancy/` — schema DDL.
  - `packages/db/prisma/migrations/20260824093802_enable_row_level_security/`
    — roles, grants, `ENABLE`/`FORCE ROW LEVEL SECURITY`, policies.
  - `packages/db/src/clients.ts` — `prisma` (owner) / `appPrisma` (`hrm_app`)
    singletons.
  - `packages/db/src/tenant-context.ts` — `withTenantContext`.
  - `packages/db/prisma/seed.ts` — demo tenant `acme-demo` + two branches
    (`countryCode` `US` and `QA`), proving branch-level country resolution.
  - `packages/db/test/tenant-isolation.spec.ts` — 9 integration tests against
    the local Postgres instance, including the crafted-where-clause attack
    and the write-time `WITH CHECK` case.
  - `packages/db/.env` / `.env.example`, `apps/api/.env.example` — added
    `APP_DATABASE_URL`; also fixed the Postgres port to `5433` to match the
    current `docker-compose.yml` (host port was moved from `5432`).
  - `apps/api/package.json` — added `--passWithNoTests` to its `test` script;
    unrelated pre-existing gap from 0.1 (no test files yet) that broke the
    root `pnpm test` once `@hrm/db` gained a real test suite.
    Verified against local Postgres on `localhost:5433`: both migrations
    applied cleanly, `pnpm --filter @hrm/db run seed` succeeds, and
    `pnpm --filter @hrm/db test` passes all 9 tests. Full-repo `pnpm build`,
    `pnpm lint`, and `pnpm test` all pass.
- **Pre-commit lint tooling fixed — 2026-08-24.** The Husky pre-commit hook
  was broken: lint-staged's `eslint --fix` failed with "Command not found"
  because `eslint` was never installed as a root devDependency (only inside
  individual workspaces), so `pnpm exec eslint` couldn't resolve it from
  repo root. Fixed by adding `eslint` + `eslint-config-prettier` to root
  `package.json` and adding a root-level `.eslintrc.js` (`root: true`) as a
  fallback for plain-JS files with no workspace of their own (root config
  files, `packages/config`'s own `*.js`, which can't extend the preset they
  define).
  That fallback config initially caused a real regression: because none of
  the existing per-workspace `.eslintrc.js`/`.json` files set `root: true`,
  ESLint's cascade merged the new root config's `eslint:recommended` (which
  turns `no-undef` on) into `apps/admin`/`apps/portal`, breaking their build
  with a false positive on `React.ReactNode` (a type-only reference, not a
  runtime one) in both `layout.tsx` files. Fixed by adding `root: true` to
  every workspace's own eslint config (`apps/api`, `apps/admin`,
  `apps/portal`, `packages/db`, `packages/shared`) so each is fully
  self-contained and the root config only ever applies to files with no
  closer config. **Convention going forward: every new workspace's eslint
  config must set `root: true`.**
  Verified: `pnpm exec eslint --version` resolves from root; `eslint --fix`
  runs correctly standalone against files in every workspace type (NestJS,
  Next.js, plain TS packages, plain JS in `packages/config`); staged a
  trivially-fixable file (`let` → `prefer-const`, unformatted JSON) and ran
  `.husky/pre-commit` directly — both `eslint --fix` and `prettier --write`
  ran and applied their fixes, hook exited 0, no `--no-verify` needed.
  Full-repo `pnpm build`, `pnpm lint`, and `pnpm test` all still pass.
- **Pre-commit lint tooling fixed again — config files vs. type-aware
  parsing — 2026-08-24.** Landing the previous fix's `apps/api/.eslintrc.js`
  (which sets `parserOptions.project`) broke linting of that same file:
  `@typescript-eslint/parser` tries to type-check every linted file against
  `tsconfig.json`, but `.eslintrc.js` isn't part of that tsconfig's
  `include` (only `src/**/*.ts` is), so parsing failed with "TSConfig does
  not include .eslintrc.js". Fixed with the standard typescript-eslint
  pattern: an `overrides` entry in `apps/api/.eslintrc.js` scoped to
  `files: ['.eslintrc.js']` that sets `parserOptions.project: null`,
  falling back to plain (non-type-aware) parsing for just that file. Real
  source under `src/**/*.ts` is untouched — confirmed via `--print-config`
  that its `parserOptions.project` is unchanged, and that a type-aware rule
  still fires there.
  No other workspace's eslint config sets `parserOptions.project` today, so
  no other file was actually affected — `.prettierrc.js`, `commitlint.config.js`,
  and both apps' `next.config.js` were already lint-clean (confirmed
  individually) since none of them go through type-aware parsing.
  **Convention update (extends the `root: true` note above): any workspace
  eslint config that sets `parserOptions.project` MUST also add an
  `overrides` entry disabling `project` (set it to `null`) for that
  workspace's own non-source config/dot files (`.eslintrc.js` itself, and
  any other root-level `*.js` config file in that workspace that isn't
  under its tsconfig's `include`) — otherwise linting that file breaks the
  moment `project` is set, exactly as happened here.**
  Verified: staged every config file that could plausibly trip the parser
  (`.eslintrc.js` at root and in every workspace, `apps/admin`/`apps/portal`
  `next.config.js`, `.prettierrc.js`, `commitlint.config.js`) together with
  a real, trivially-fixable `apps/api/src/*.ts` file, and ran
  `.husky/pre-commit` directly: `eslint --fix` and `prettier --write` both
  ran, the source file's `let` → `const` fix was applied, no config file
  errored, hook exited 0, no `--no-verify`. Full-repo `pnpm build` (5/5),
  `pnpm lint` (7/7), and `pnpm test` (all green, including all 9 RLS
  integration tests) still pass.
- **0.3 tenant resolution — done — 2026-08-24.** Every non-public request
  now resolves its tenant (subdomain → custom domain → header, configurable
  order) and runs entirely inside `withTenantContext`, so 0.2's RLS is
  enforced automatically for the whole request — application code never
  touches the migration client. Full design in § Conventions → Tenant
  resolution above. Files:
  - `packages/db/prisma/schema.prisma` — new `TenantDomain` model
    (custom-domain → tenant mapping), RLS-exempt like `Tenant`, plus a
    `domains` back-relation on `Tenant`.
  - `packages/db/prisma/migrations/20260824104404_add_tenant_domains/` —
    the table.
  - `packages/db/prisma/migrations/20260824104420_grant_tenant_domains_select/`
    — `GRANT SELECT ... TO hrm_app` only (no ENABLE/FORCE ROW LEVEL SECURITY,
    no policy — deliberate).
  - `apps/api/src/tenancy/tenant-context.store.ts` — the
    `AsyncLocalStorage<RequestTenantStore>` single source of truth for the
    request's `{ tenantId, branchId, userId, roles, platform, tx }`.
  - `apps/api/src/tenancy/tenant-context.service.ts` — injectable
    `TenantContextService` (`getContext()`, `getTx()`, `run()`).
  - `apps/api/src/tenancy/current-tenant.decorator.ts` — `@CurrentTenant()`.
  - `apps/api/src/tenancy/public.decorator.ts` / `platform-route.decorator.ts`
    — `@Public()`, `@PlatformRoute()`.
  - `apps/api/src/tenancy/tenant-resolution.service.ts` — the three
    strategies, all querying `appPrisma` directly (no tenant context needed
    — see above).
  - `apps/api/src/tenancy/tenant-scope.interceptor.ts` — the global
    `APP_INTERCEPTOR` tying resolution, the transaction, and
    `AsyncLocalStorage` propagation together.
  - `apps/api/src/tenancy/tenancy.module.ts`, `tenancy.controller.ts`
    (`GET /tenancy/whoami`, `GET /tenancy/branches` — example protected
    routes proving the pipeline end to end) — `@Global()` so the service/
    decorator work from any module.
  - `apps/api/src/platform/platform.controller.ts` — `GET /platform/ping`,
    the platform-context seam's minimal proof.
  - `apps/api/src/app.module.ts` (imports `TenancyModule`),
    `app.controller.ts` (`/health` now `@Public()`).
  - `apps/api/.env` / `.env.example` — added `APP_DATABASE_URL` (apps/api
    never actually had it despite depending on `@hrm/db` since 0.2 — dead
    gap, now fixed), `TENANT_RESOLUTION_STRATEGIES`, `TENANT_BASE_DOMAIN`,
    `PLATFORM_MODE_ENABLED`; removed the unused `DEFAULT_TENANT_ID` left
    over from 0.1.
  - `apps/api/jest.config.js` / `jest.setup.js` — apps/api had **no** jest
    config at all before this (only bare devDependencies); added the same
    `ts-jest` + `dotenv`-preloaded pattern already used by `packages/db`.
  - `apps/api/test/tenant-resolution.e2e-spec.ts` — 10 integration tests
    over real HTTP against local Postgres (see below).
  - `apps/api/tsconfig.json` — widened `include` to also cover
    `test/**/*.ts` (it previously only covered `src/**/*.ts`, which is what
    caused the `.eslintrc.js`-style "TSConfig does not include" parsing
    error to resurface for the new e2e spec file the moment it was added;
    `tsconfig.build.json` already excludes `test/` and `**/*spec.ts`
    independently, so the production build is unaffected). **Convention
    update: test files get real type-aware linting like any other source —
    they belong in the base tsconfig's `include`, not nulled out via the
    `.eslintrc.js`-style `overrides` escape hatch, which is reserved for
    genuinely non-source config/dot files.**
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 10 new e2e tests pass (subdomain isolation ×2,
    header isolation by id and by slug, custom-domain resolution, unresolvable
    → 401, `/health` public with no tenant, crafted `?tenantId=` query param
    proven blocked by RLS through the HTTP layer, `@CurrentTenant()` shape,
    platform route rejected while disabled). Full-repo `pnpm build` (5/5),
    `pnpm lint` (7/7), `pnpm test` (all green — the original 9 RLS DB tests
    plus these 10, 19 total) all pass.
- **0.4 auth + RBAC — done — 2026-08-24.** Populates the `userId`/`roles`/
  `permissions`/`branchIds` that 0.3 left nullable. Full design in §
  Conventions → Auth / RBAC model above — summary: argon2id local auth
  behind an SSO seam, JWT access + Redis-tracked rotating refresh tokens
  with family-wide reuse revocation, DB-backed deny-by-default RBAC (roles/
  permissions are editable data, never hardcoded), branch scoping on top of
  tenant RLS, and a reusable declarative field-level permission
  serialization pattern. Files:
  - `packages/db/prisma/schema.prisma` — `Permission`, `Role`,
    `RolePermission`, `UserRole`, `UserBranch` (all tenant-scoped, RLS
    applies), plus `roles`/`userRoles`/`userBranches` relations on
    `User`/`Tenant`/`Branch`.
  - `packages/db/prisma/migrations/20260824120000_add_rbac_and_branch_scoping/`
    — the five tables (generated via `prisma migrate diff` +
    `migrate deploy`, since `migrate dev` needs a TTY this environment
    doesn't have — see below).
  - `packages/db/prisma/migrations/20260824120500_enable_rls_for_rbac_tables/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all five, identical pattern to every 0.2 table, applied fresh
    rather than editing an existing policy.
  - `packages/db/src/seed-rbac.ts` — `seedSystemRolesAndPermissions(client, tenantId)`,
    idempotent, shared by `prisma/seed.ts` and this step's test fixtures;
    the function real tenant provisioning (0.6) should call too.
  - `packages/shared/src/constants/permissions.ts` — `PERMISSIONS`,
    `SYSTEM_ROLES`, `SYSTEM_ROLE_PERMISSIONS` (seed defaults only, see
    Conventions).
  - `packages/shared/src/validators/auth.validator.ts` — zod schemas/types
    for login/refresh/change-password/request-reset/reset.
  - `apps/api/src/redis/` — shared `ioredis` client (`REDIS_CLIENT` token),
    global module; refresh tokens and rate-limit counters both live here.
  - `apps/api/src/common/rate-limit/rate-limiter.service.ts` — Redis
    fixed-window limiter.
  - `apps/api/src/common/pipes/zod-validation.pipe.ts` — validates request
    bodies against `packages/shared`'s zod schemas.
  - `apps/api/src/common/permissions/` — `RequiresPermission()`,
    `PermissionSerializerInterceptor`, and the `demo/` reference DTO +
    controller proving the pattern (see Conventions for the full example).
  - `apps/api/src/auth/` — `AuthService`, `AuthController`
    (`login`/`refresh`/`logout`/`logout-all`/`me`/`change-password`/
    `request-password-reset`/`reset-password`/`rbac-demo`), `PasswordService`
    (argon2id), `TokenService` (JWT + Redis refresh rotation),
    `load-user-context.util.ts` (shared by `AuthService.login` and the
    interceptor), `auth-events.ts`, `providers/` (the SSO seam +
    `LocalAuthProvider`), `decorators/` (`@AllowAnonymous()`,
    `@RequirePermissions()`), `guards/permissions.guard.ts`,
    `listeners/audit-events.listener.ts`.
  - `apps/api/src/tenancy/tenant-context.store.ts` — extended
    `RequestTenantStore` with `permissions`/`branchIds` (the extension 0.3
    documented as the sanctioned way to grow this shape).
  - `apps/api/src/tenancy/tenant-scope.interceptor.ts` — extended (not
    replaced) with JWT verification + DB-backed context population for
    every non-`@AllowAnonymous()` request; see Conventions for why this
    couldn't be a separate interceptor or a `CanActivate` guard.
  - `apps/api/src/tenancy/tenancy.controller.ts` — `GET /tenancy/branches`
    now also enforces branch scoping on top of the existing tenant-RLS +
    crafted-where-clause proof from 0.3.
  - `apps/api/src/app.module.ts` — added `RedisModule`, `AuthModule`,
    `EventEmitterModule.forRoot({ wildcard: true })`.
  - `apps/api/.env` / `.env.example` — added `APP_DATABASE_URL` (apps/api
    never actually had it despite depending on `@hrm/db` since 0.2 — a dead
    gap from 0.3, now fixed); no other new vars needed, `JWT_*`/`REDIS_URL`
    were already documented in 0.1.
  - `apps/api/jest.config.js` — `testMatch` widened to `test/**/*.e2e-spec.ts`
    in addition to `src/**/*.spec.ts` (already the case since 0.3; unchanged
    here, noted for completeness).
  - `apps/api/tsconfig.json` — no change needed this step; 0.3 already
    fixed `include` to cover `test/**/*.ts`.
  - `apps/api/test/auth-rbac.e2e-spec.ts` — 16 new integration tests (see
    Conventions for the full list).
  - `apps/api/test/tenant-resolution.e2e-spec.ts` — updated: `/tenancy/*`
    now correctly requires authentication, so these 0.3 tests mint a JWT
    directly (bypassing the real login flow, which is this step's concern,
    not 0.3's) to keep testing tenant resolution specifically. Also fixed a
    test-teardown leak (`appPrisma` and the app's Redis client were never
    disconnected, leaving dangling handles) surfaced while adding the new
    suite's teardown.
    Note for future work: `prisma migrate dev` refused to run at all in this
    environment ("non-interactive... not supported" — no TTY), including with
    `--create-only`. Non-interactive migration authoring uses
    `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script`
    (needs a shadow database to already exist — create it by hand first,
    `CREATE DATABASE hrm_dev_shadow`, if `migrate dev` hasn't already left one
    around) piped into a manually-created migration folder, then
    `prisma migrate deploy` to apply it. Same net result as `migrate dev`,
    just without the interactive confirmation prompt.
    Also found and fixed a real bug while writing this step's tests: the
    Redis rate limiter counted successful logins toward the same window as
    failed ones, so a legitimately-fast sequence of successful test logins
    for one account tripped 429 partway through — fixed by resetting the
    counter on success (`RateLimiterService.reset`), which is also the
    correct security behavior (the window should punish a run of failures,
    not cap legitimate use).
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 16 new tests pass, all 10 updated 0.3 tests still
    pass, all 9 packages/db RLS tests still pass (35 total). Full-repo
    `pnpm build` (5/5), `pnpm lint` (7/7), `pnpm test` all green.
- **0.5 country packs — done — 2026-08-25.** The keystone customization
  system: a versioned, system-owned `CountryPack` per country plus an
  optional per-tenant `TenantCountryOverride` diff, resolved via
  `Branch.countryCode` (falling back to `Tenant.defaultCountryCode`), and a
  sandboxed rules engine that evaluates tax/statutory pack data instead of
  ever branching on a country code. Full design in § Conventions → Country
  packs above. Files:
  - `packages/db/prisma/schema.prisma` — `CountryPack` (no `tenantId` —
    global, RLS-exempt like `Tenant`/`TenantDomain`) and
    `TenantCountryOverride` (tenant-scoped, ordinary RLS), plus a
    `countryOverrides` back-relation on `Tenant`.
  - `packages/db/prisma/migrations/20260825090000_add_country_packs/` —
    both tables (generated via `prisma migrate diff` + `migrate deploy`,
    same non-interactive method 0.4 documented — no TTY in this
    environment for `migrate dev`).
  - `packages/db/prisma/migrations/20260825090500_enable_rls_for_country_overrides/`
    — `GRANT SELECT` only on `country_packs` (no RLS — no `tenant_id`
    column to filter on); `ENABLE`/`FORCE ROW LEVEL SECURITY` + the
    standard `tenant_isolation` policy on `tenant_country_overrides`,
    identical pattern to every other tenant-owned table.
  - `packages/shared/src/validators/rules-engine.validator.ts` — `Expr`
    (the whitelisted formula AST) + `exprSchema`, `TaxLayer`/
    `taxLayerSchema` (`PROGRESSIVE_BRACKETS`/`FLAT_RATE`/`FORMULA`),
    `StatutoryComponent`/`statutoryComponentSchema`
    (`PERCENTAGE`/`TIERED_BY_YEARS_OF_SERVICE`/`FORMULA`).
  - `packages/shared/src/validators/country-pack.validator.ts` —
    `countryPackConfigSchema` (the full pack shape) and
    `tenantCountryOverrideSchema` (the `.strict()`, override-only-safe
    subset).
  - `packages/shared/src/constants/permissions.ts` — new
    `COUNTRY_PACK_OVERRIDE_MANAGE` (`country_pack.override.manage`)
    permission, granted to `HR_MANAGER` explicitly (and to `TENANT_ADMIN`
    implicitly via `ALL_PERMISSIONS`).
  - `packages/db/src/seed-country-packs.ts` — `seedCountryPacks()` +
    the exported `USA_PACK`/`QATAR_PACK` reference configs (see
    Conventions for what each encodes), called by `prisma/seed.ts`.
  - `apps/api/src/country-packs/rules-engine/expression-evaluator.ts` —
    `evaluateExpression`, the sandboxed interpreter (the actual security
    boundary — see Conventions), and `UnsafeExpressionError`.
  - `apps/api/src/country-packs/rules-engine/tax-calculator.ts` /
    `statutory-calculator.ts` — the generic, data-driven algorithms for
    each `kind`, plus the `FORMULA` delegation to the evaluator.
  - `apps/api/src/country-packs/country-pack-override.util.ts` —
    `mergeCountryPackConfig` (the two-layer merge) and
    `assertLeaveBoundsRespected` (the leave-floor bound).
  - `apps/api/src/country-packs/country-pack-resolution.service.ts` —
    `CountryPackResolutionService` (branch → country code →
    pack-merged-with-override), re-validating both the pack's `config` and
    the override's `overrides` against the shared schemas on every read,
    not just at write time.
  - `apps/api/src/country-packs/country-packs.controller.ts` /
    `country-packs.module.ts` — the three routes (see Conventions),
    registered in `apps/api/src/app.module.ts`.
  - `apps/api/src/country-packs/rules-engine/expression-evaluator.spec.ts`
    / `tax-calculator.spec.ts` / `statutory-calculator.spec.ts` /
    `pack-schema-sandbox.spec.ts` — 33 unit tests: the evaluator's
    whitelist rejecting every out-of-whitelist shape, `exprSchema`
    rejecting the same independently (the schema has no jest setup of its
    own — see that file's header comment for why these live in
    `apps/api` instead), and real US multi-layer-tax / Qatar
    end-of-service-gratuity computations against the actual seeded pack
    constants.
  - `apps/api/test/country-packs.e2e-spec.ts` — 9 integration tests over
    real HTTP (see Conventions for the full list); mints a JWT directly
    rather than exercising the real login flow, same rationale
    `tenant-resolution.e2e-spec.ts` documented in 0.3/0.4.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all new tests pass (42 new: 33 unit + 9 e2e), all 26
    existing `apps/api` e2e tests still pass, all 9 `packages/db` RLS tests
    still pass (77 total). Full-repo `pnpm build` (5/5), `pnpm lint` (7/7),
    `pnpm test` all green.
- **0.6 licensing / feature flags — done — 2026-08-25.** Gates
  functionality by edition across BOTH delivery modes (SaaS subscription,
  lifetime/on-prem signed license file) from one resolution service, plus
  the platform-admin issue/revoke/flag-override surface and offline
  challenge-response activation. Full design in § Conventions → Licensing
  / feature flags above. Files:
  - `packages/db/prisma/schema.prisma` — `Subscription` (SaaS entitlement
    source, `@@unique([tenantId])`), `License` (lifetime entitlement
    source, keeps `signedToken` for re-verification, history via
    `SUPERSEDED`/`REVOKED`/`EXPIRED` status rather than deletion),
    `TenantFeatureFlagOverride` (tenant-scoped, `@@unique([tenantId, flagKey])`)
    — all three ordinary RLS-protected tables, plus `subscription`/
    `licenses`/`featureFlagOverrides` relations on `Tenant`.
  - `packages/db/prisma/migrations/20260825140000_add_licensing/` — the
    three tables (generated via `prisma migrate diff` + `migrate deploy`,
    same non-interactive method 0.4/0.5 documented).
  - `packages/db/prisma/migrations/20260825140500_enable_rls_for_licensing/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all three (unlike 0.5's `CountryPack`, none of these tables
    are RLS-exempt — there's no "must resolve before a tenant context
    exists" reason here).
  - `packages/db/src/seed-licensing.ts` — `seedDemoSubscription()` (an
    ACTIVE PROFESSIONAL subscription for the demo tenant), called by
    `prisma/seed.ts`.
  - `packages/shared/src/constants/feature-flags.ts` — `FEATURE_FLAGS`,
    `EDITION_FEATURES` (the static edition → flags mapping).
  - `packages/shared/src/constants/permissions.ts` — new
    `LICENSE_MANAGE` (`license.manage`) permission, granted to
    `TENANT_ADMIN` only (via `ALL_PERMISSIONS`) — deliberately not
    `HR_MANAGER`, unlike 0.5's country-pack-override permission; license
    management is ownership/IT territory, not HR policy.
  - `packages/shared/src/validators/license.validator.ts` —
    `licensePayloadSchema` (the signed file's custom claims),
    `issueLicenseRequestSchema`, `revokeLicenseRequestSchema`,
    `activationCompleteRequestSchema`, `flagOverrideRequestSchema`.
  - `apps/api/src/licensing/license-signing.service.ts` /
    `license-verification.service.ts` — the RS256 sign/verify split (see
    Conventions for why this is the structural half of the key-handling
    rule).
  - `apps/api/src/licensing/feature-flag-resolution.service.ts` — the one
    entitlement-resolution entry point for both modes plus the override
    layer.
  - `apps/api/src/licensing/seat-cap.service.ts` — the shared seat-count
    check both modes call, with opposite blocking behavior applied by the
    resolution service, not by this service itself.
  - `apps/api/src/licensing/require-feature.decorator.ts` /
    `feature-flag.guard.ts` — `@RequireFeature()` +
    `FeatureFlagGuard`.
  - `apps/api/src/licensing/license-activation.service.ts` — the
    on-prem-instance side of activation (challenge generation +
    challenge-response completion), Redis-backed.
  - `apps/api/src/licensing/licensing-admin.service.ts` /
    `licensing-admin.controller.ts` — the vendor/platform side
    (issue/revoke/flag-override), querying `prisma` (owner client)
    directly per the Platform context convention above.
  - `apps/api/src/licensing/licensing.controller.ts` — tenant-scoped
    routes: `GET /licensing/entitlements` (this step's required proof
    endpoint), `POST /licensing/activation/{challenge,complete}`,
    `GET /licensing/demo/advanced-reporting` (the `@RequireFeature`
    reference usage).
  - `apps/api/src/licensing/licensing-events.ts` /
    `listeners/licensing-events.listener.ts` — the `licensing.*` event
    contract + placeholder logger, mirroring `auth-events.ts`/
    `AuditEventsListener` exactly.
  - `apps/api/src/licensing/licensing.module.ts`, registered in
    `apps/api/src/app.module.ts`.
  - `apps/api/keys/` — the dev RS256 keypair (`license-public-dev.pem`
    committed, `license-private-dev.pem` gitignored) + `README.md`
    documenting the key-handling rule and regeneration steps.
  - `.gitignore` — added `apps/api/keys/*private*.pem`.
  - `apps/api/.env` / `.env.example` — added `LICENSE_PUBLIC_KEY_PATH`,
    `LICENSE_PRIVATE_KEY_PATH`; updated the `LICENSE_KEY`/
    `PLATFORM_MODE_ENABLED` comments (the former is now superseded by the
    DB-backed activation flow; the latter no longer claims "no tenant-
    scoped DB access is granted" now that the licensing admin endpoints
    exist).
  - `apps/api/test/licensing-saas.e2e-spec.ts` /
    `licensing-lifetime.e2e-spec.ts` — 21 new integration tests (see
    Conventions for the full list); each forces `LICENSE_MODE`/
    `PLATFORM_MODE_ENABLED` via `process.env` at module load, before the
    other mode's/seam's own e2e defaults, safe because jest runs each
    test file in its own worker process.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 21 new tests pass, all 68 existing `apps/api`
    tests still pass, all 9 `packages/db` RLS tests still pass (98 total).
    Full-repo `pnpm build` (5/5), `pnpm lint` (7/7), `pnpm test` all green.
- **0.7 workflow / approval engine — done — 2026-08-25.** ONE generic,
  reusable approval engine — sequential/parallel/conditional steps,
  pluggable approver-rule resolution, delegation, escalation-on-timeout,
  auto-approval, and a polymorphic instance model any future module
  (leave, expenses, regularizations, offer approvals, ...) consumes
  as-is. Full design in § Conventions → Workflow / approval engine above.
  Files:
  - `packages/db/prisma/schema.prisma` — `WorkflowTemplate`, `WorkflowStep`,
    `WorkflowInstance`, `WorkflowInstanceStep`, `WorkflowAction` (all
    tenant-scoped, ordinary RLS), plus the three approver-rule SEAM
    columns: `User.managerId` (self-relation), `Branch.headUserId` /
    `Department.headUserId` (composite FK to `User`) — and the matching
    back-relations on `Tenant`/`User`.
  - `packages/db/prisma/migrations/20260825150000_add_workflow_engine/` —
    the three new enums, the five tables, and the three seam columns
    (generated via `prisma migrate diff` + `migrate deploy`, same
    non-interactive method 0.4/0.5/0.6 documented).
  - `packages/db/prisma/migrations/20260825150500_enable_rls_for_workflow_engine/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all five workflow tables, identical pattern to every other
    tenant-owned table (no exemption needed here, unlike 0.5's
    `CountryPack` — nothing about workflow resolution has to run before a
    tenant context exists).
  - `packages/shared/src/validators/workflow.validator.ts` — `WorkflowValueExpr`/
    `workflowValueExprSchema`, `WorkflowCondition`/`workflowConditionSchema`
    (the condition sandbox — see Conventions for exactly what's reused
    from 0.5 vs. genuinely new), `ApproverRule`/`approverRuleSchema`,
    `startWorkflowInstanceSchema`, `workflowStepActionSchema`.
  - `packages/shared/src/constants/permissions.ts` — new
    `WORKFLOW_PARTICIPATE` (`workflow.participate`, granted to every
    seeded system role) and `WORKFLOW_MANAGE` (`workflow.manage`,
    `TENANT_ADMIN` implicitly + `HR_MANAGER` explicitly).
  - `apps/api/src/workflow/condition-evaluator.ts` — `evaluateWorkflowValueExpr`/
    `evaluateWorkflowCondition`, the sandboxed interpreter.
  - `apps/api/src/workflow/approver-resolver.service.ts` —
    `ApproverResolverService`, one strategy per `ApproverRule` kind
    (see Conventions for the `MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD`
    pluggable-seam write-up).
  - `apps/api/src/workflow/workflow-engine.service.ts` —
    `WorkflowEngineService`: `startInstance`, `actOnStep`,
    `cancelInstance`, `getInstanceDetail`, `myPendingApprovals`, and the
    private `activateNextGroup`/`checkGroupCompletionAndAdvance`/
    `finalize` state-machine core.
  - `apps/api/src/workflow/workflow-escalation.service.ts` —
    `WorkflowEscalationService.sweepOverdueSteps()`, the cross-tenant
    timeout sweep (see Conventions for the `prisma`-for-discovery /
    `withTenantContext`-for-mutation split).
  - `apps/api/src/workflow/workflow-events.ts` /
    `listeners/workflow-events.listener.ts` — the `workflow.*` event
    contract + placeholder logger, mirroring `auth-events.ts`/
    `licensing-events.ts` exactly.
  - `apps/api/src/workflow/workflow.controller.ts` /
    `workflow.module.ts` — the five generic routes, registered in
    `apps/api/src/app.module.ts`.
  - `apps/api/src/workflow/condition-evaluator.spec.ts` — 14 unit tests
    (arithmetic/comparison/boolean-combinator correctness, sandbox
    rejection of every out-of-whitelist shape).
  - `apps/api/test/workflow.e2e-spec.ts` — 12 integration tests over real
    HTTP (see Conventions for the full list); templates/steps seeded
    directly via the owner `prisma` client, same fixture convention as
    every other module's tests in this suite.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 26 new tests pass, all 98 existing tests still
    pass (124 total: 9 `packages/db` RLS + 115 `apps/api`). Full-repo
    `pnpm build` (5/5), `pnpm lint` (7/7), `pnpm test` all green.
- **0.8 notifications hub — done — 2026-08-26.** The delivery layer for
  every domain event emitted since auth (0.4), licensing (0.6), and
  workflow (0.7) — in-app/email/SMS/push channels behind a swappable
  provider seam, async delivery through the first BullMQ queue in this
  system (with retry + backoff + a dead-letter path), an event ->
  notification mapping layer, recipient-locale-driven template rendering
  reusing 0.5's Country Pack locale, and per-user channel preferences.
  Password reset (0.4) is wired as the first real consumer, replacing its
  dev-log stub. Full design in § Conventions → Notifications hub above.
  Files:
  - `packages/db/prisma/schema.prisma` — `NotificationChannel`/
    `NotificationDeliveryStatus` enums; `Notification`, `NotificationDelivery`,
    `NotificationPreference` (all tenant-scoped, ordinary RLS); `NotificationTemplate`
    (global, RLS-exempt like `CountryPack`); `User.preferredLanguage`
    (new nullable seam column); the five new back-relations on `Tenant`.
  - `packages/db/prisma/migrations/20260826090000_add_notifications_hub/`
    — the two enums, four tables, and `users.preferred_language` column
    (generated via `prisma migrate diff` + `migrate deploy`, same
    non-interactive method every prior step since 0.4 documented).
  - `packages/db/prisma/migrations/20260826090500_enable_rls_for_notifications/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on `notifications`/`notification_deliveries`/
    `notification_preferences`; `GRANT SELECT` only (no RLS) on
    `notification_templates`, identical exemption to `country_packs`.
  - `packages/db/src/seed-notification-templates.ts` —
    `seedNotificationTemplates()`, the externalized en/ar copy for all 7
    mapped event types, called by `prisma/seed.ts`.
  - `packages/shared/src/notifications/channel.ts` — `NOTIFICATION_CHANNELS`/
    `NotificationChannel`.
  - `packages/shared/src/notifications/event-notification-mapping.ts` —
    `NOTIFICATION_EVENT_TYPES`/`NotificationEventType`/
    `isNotificationEventType`/`DEFAULT_NOTIFICATION_CHANNELS`.
  - `packages/shared/src/notifications/provider.interface.ts` —
    `NotificationProvider`/`NotificationProviderSendParams`, the
    channel-provider seam contract.
  - `packages/shared/src/notifications/rtl-languages.ts` — `isRtlLanguage`.
  - `packages/shared/src/validators/notification.validator.ts` — the
    `PUT /notifications/preferences` body schema.
  - `apps/api/src/queue/queue.module.ts` / `queue.constants.ts` — the
    reusable BullMQ infrastructure (see Conventions for the plain-options-
    not-a-shared-client design decision and why).
  - `apps/api/src/notifications/notifications.service.ts` — the producer
    (`handleDomainEvent`): recipient resolution, preference filtering, row
    creation, the bounded empty-recipients retry, job enqueue.
  - `apps/api/src/notifications/notification-recipient-resolver.service.ts`
    — the per-event-type WHO-receives-this switch.
  - `apps/api/src/notifications/notification-preference.service.ts` —
    default-vs-override channel resolution + the preferences CRUD used by
    the controller.
  - `apps/api/src/notifications/notification-locale-resolver.service.ts` —
    recipient locale resolution (preference override, else branch/Country
    Pack), independent of `TenantContextService`.
  - `apps/api/src/notifications/notification-template-renderer.service.ts`
    — template lookup (with `"en"` fallback) + `{{placeholder}}`
    substitution.
  - `apps/api/src/notifications/notification-delivery.service.ts` — the
    consumer (`deliver`): render, send (skipped for `IN_APP`), record
    SENT/FAILED/DEAD_LETTER across three separate transactions.
  - `apps/api/src/notifications/notification.processor.ts` — the BullMQ
    `@Processor('notifications')`/`WorkerHost` adapter.
  - `apps/api/src/notifications/providers/` — `notification-provider.tokens.ts`
    (`EMAIL_PROVIDER`/`SMS_PROVIDER`/`PUSH_PROVIDER`) and the three
    `LogXxxProvider` dev implementations.
  - `apps/api/src/notifications/listeners/notification-dispatch.listener.ts`
    — subscribes to `auth.*`/`licensing.*`/`workflow.*`, the same events
    the three existing placeholder audit listeners already consume.
  - `apps/api/src/notifications/notifications.controller.ts` /
    `notifications.module.ts` — the four routes, registered in
    `apps/api/src/app.module.ts` alongside `QueueModule`.
  - `apps/api/src/auth/auth-events.ts` — `AuthEventPayload` gained an
    optional, documented-sensitive `token` field.
  - `apps/api/src/auth/auth.service.ts` — `requestPasswordReset` now
    attaches `token` to the emitted event instead of a dev-only
    `logger.log`; the now-unused `ConfigService`/`Logger` were removed
    from the constructor.
  - `apps/api/src/notifications/notification-locale-resolver.service.spec.ts`
    — 3 integration tests (US branch -> en/LTR, Qatar branch -> ar/RTL, a
    `preferredLanguage` override winning over the branch default).
  - `apps/api/test/notifications.e2e-spec.ts` — 6 integration tests over
    real HTTP (see Conventions → Verified-by for the full list).
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 9 new tests pass, all 124 existing tests still
    pass (133 total: 9 `packages/db` RLS + 124 `apps/api`). Full-repo
    `pnpm build` (5/5), `pnpm lint` (7/7), `pnpm test` all green.

## 6. Not yet built

- [x] **0.2** Tenancy model / Row-Level Security (RLS)
- [x] **0.3** Tenant resolution (request → tenant binding)
- [x] **0.4** Auth / RBAC
- [x] **0.5** Country packs
- [x] **0.6** Licensing (SaaS vs. lifetime on-prem enforcement)
- [x] **0.7** Workflow engine
- [x] **0.8** Notifications
- [ ] **0.9** Audit logging, custom fields, i18n
- [ ] **0.10** Resilience (graceful degradation, backpressure, circuit breaking)
- [ ] **Phase 1** — _scope not yet defined_
- [ ] **Phase 2** — _scope not yet defined_
- [ ] **Phase 3** — _scope not yet defined_
- [ ] **Phase 4** — _scope not yet defined_
- [ ] **Phase 5** — _scope not yet defined_
- [ ] **Phase 6** — _scope not yet defined_
