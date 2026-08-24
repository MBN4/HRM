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
- **Country resolution** — _to be defined in step 0.5 (country packs), in
  coordination with step 0.3 (tenant resolution)._ Note: country is resolved
  at the **Branch** level (`Branch.countryCode`), not the tenant level — one
  tenant can operate branches in different countries. `Tenant.defaultCountryCode`
  is only a fallback for branches that haven't been assigned one.
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
- **Auth / RBAC model** — _to be defined in step 0.4._ Will populate
  `branchId`/`userId`/`roles` in the request context above; the shape
  already exists.
- **Licensing model** (SaaS vs. on-prem enforcement) — _to be defined in step
  0.6._

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

## 6. Not yet built

- [x] **0.2** Tenancy model / Row-Level Security (RLS)
- [x] **0.3** Tenant resolution (request → tenant binding)
- [ ] **0.4** Auth / RBAC
- [ ] **0.5** Country packs
- [ ] **0.6** Licensing (SaaS vs. lifetime on-prem enforcement)
- [ ] **0.7** Workflow engine
- [ ] **0.8** Notifications
- [ ] **0.9** Audit logging, custom fields, i18n
- [ ] **0.10** Resilience (graceful degradation, backpressure, circuit breaking)
- [ ] **Phase 1** — _scope not yet defined_
- [ ] **Phase 2** — _scope not yet defined_
- [ ] **Phase 3** — _scope not yet defined_
- [ ] **Phase 4** — _scope not yet defined_
- [ ] **Phase 5** — _scope not yet defined_
- [ ] **Phase 6** — _scope not yet defined_
