# HRM — Build Log

[← Back to CLAUDE.md](../CLAUDE.md)

This is the full, append-only build history for the HRM project — moved out
of the root `CLAUDE.md` (2026-08-27 docs reorganization) to keep that file a
lean entry point. **Every step from here forward still appends here, not
back into CLAUDE.md** — see CLAUDE.md's "How to use these docs" note. Never
edit or delete a prior entry; if something is superseded, say so in a new
entry instead.

For the architectural _why_ behind any of these steps, see the matching file
under [`docs/conventions/`](./conventions/) — this log is the "what landed
and when," the conventions docs are the "how it works and why it's built
that way."

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
  against a new non-superuser `hrm_app` role — see
  [`docs/conventions/tenancy-rls.md`](./conventions/tenancy-rls.md) for the
  full design and why two DB roles are required for RLS to actually take
  effect. Files:
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
  config must set `root: true`.** See
  [`docs/conventions/tooling-eslint-config.md`](./conventions/tooling-eslint-config.md).
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
  moment `project` is set, exactly as happened here.** See
  [`docs/conventions/tooling-eslint-config.md`](./conventions/tooling-eslint-config.md).
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
  touches the migration client. Full design in
  [`docs/conventions/tenant-resolution.md`](./conventions/tenant-resolution.md).
  Files:
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
  `permissions`/`branchIds` that 0.3 left nullable. Full design in
  [`docs/conventions/auth-rbac.md`](./conventions/auth-rbac.md) and
  [`docs/conventions/field-level-permissions.md`](./conventions/field-level-permissions.md)
  — summary: argon2id local auth behind an SSO seam, JWT access +
  Redis-tracked rotating refresh tokens with family-wide reuse revocation,
  DB-backed deny-by-default RBAC (roles/permissions are editable data,
  never hardcoded), branch scoping on top of tenant RLS, and a reusable
  declarative field-level permission serialization pattern. Files:
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
  ever branching on a country code. Full design in
  [`docs/conventions/country-packs.md`](./conventions/country-packs.md).
  Files:
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
  challenge-response activation. Full design in
  [`docs/conventions/licensing-feature-flags.md`](./conventions/licensing-feature-flags.md).
  Files:
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
  as-is. Full design in
  [`docs/conventions/workflow.md`](./conventions/workflow.md). Files:
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
  dev-log stub. Full design in
  [`docs/conventions/notifications-queues.md`](./conventions/notifications-queues.md).
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
- **0.9 audit logging, custom fields, i18n — done — 2026-08-27.** Three
  cross-cutting foundations: an append-only, DB-level-immutable audit log
  fed automatically by both HTTP-mutation interceptor capture and the
  existing `auth`/`licensing`/`workflow`/`notification` domain events; a
  tenant-extensible custom-fields mechanism for entities with no schema
  migration; and a formalized i18n/timezone/RTL convention unifying what
  0.5/0.8 had already established ad hoc. Full design in
  [`docs/conventions/audit-custom-fields.md`](./conventions/audit-custom-fields.md)
  and [`docs/conventions/i18n-timezone-rtl.md`](./conventions/i18n-timezone-rtl.md).
  Files:
  - `packages/db/prisma/schema.prisma` — `AuditLog` (composite
    `(id, occurredAt)` PK, partition-ready), `CustomFieldType` enum,
    `CustomFieldDefinition`, `CustomFieldValueSet`, plus the three new
    back-relations on `Tenant`.
  - `packages/db/prisma/migrations/20260827090000_add_audit_and_custom_fields/`
    — the enum and three tables (generated via `prisma migrate diff` +
    `migrate deploy`, same non-interactive method every prior step since
    0.4 documented).
  - `packages/db/prisma/migrations/20260827090500_enable_rls_for_audit_and_custom_fields/`
    — ordinary `tenant_isolation` RLS on the two custom-field tables;
    `audit_log` gets the same RLS policy PLUS an explicit
    `REVOKE UPDATE, DELETE ... FROM hrm_app` (only `SELECT`/`INSERT`
    granted) — the DB-level immutability guarantee, verified directly
    against Postgres via `psql` during this step and by
    `packages/db/test/audit-log-immutability.spec.ts`.
  - `packages/shared/src/i18n/` — `rtl.ts` (`isRtlLanguage`, moved/
    generalized from the deleted `notifications/rtl-languages.ts`, plus
    new `directionFor`), `interpolate.ts` (`interpolateTemplate`, promoted
    out of `NotificationTemplateRenderer`), `timezone.ts`
    (`formatInTimeZone`/`assertValidTimeZone`/`toUtcIsoString`),
    `messages.ts` (`UI_MESSAGES`/`translate`, the new web-app UI catalog).
  - `packages/shared/src/audit/` — `redact.ts` (`redactSensitiveFields`,
    the one redaction backstop both audit capture paths call) and
    `audit-events.ts` (`AUDIT_ACTIONS`, `AuditLogEntryDto`).
  - `packages/shared/src/validators/audit.validator.ts` /
    `custom-field.validator.ts` — `auditQuerySchema`,
    `defineCustomFieldSchema` (`.strict()` + `.refine()` on the
    ENUM/`options` pairing), `setCustomFieldValuesSchema`.
  - `packages/shared/src/constants/permissions.ts` — new `AUDIT_READ`
    (`TENANT_ADMIN` only, via `ALL_PERMISSIONS`) and
    `CUSTOM_FIELD_MANAGE` (`TENANT_ADMIN` implicitly + `HR_MANAGER`
    explicitly) permissions.
  - `apps/api/src/audit/` — `audit-capture.store.ts`/`audit-capture.service.ts`
    (the route-handler "before" snapshot hook, its own isolated
    `AsyncLocalStorage`), `audit-log.decorator.ts` (`@AuditLog()`),
    `audit-record.service.ts` (`AuditRecordService`, the one write path —
    `recordWithinTransaction` for HTTP mutations,
    `recordForTenant` for domain events), `audit.interceptor.ts`
    (`AuditInterceptor`), `audit-query.service.ts`/`audit.controller.ts`
    (`GET /audit`), `listeners/domain-event-audit.listener.ts`
    (`DomainEventAuditListener`, replacing and deleting the three
    placeholder loggers — `auth/listeners/audit-events.listener.ts`,
    `licensing/listeners/licensing-events.listener.ts`,
    `workflow/listeners/workflow-events.listener.ts`), `audit.module.ts`.
  - `apps/api/src/custom-fields/` — `custom-field-definition.service.ts`,
    `custom-field-value.service.ts`, `custom-fields.controller.ts`
    (`POST`/`GET .../definitions`, `PUT`/`GET .../values/:entityType/:entityId`),
    `custom-fields.module.ts`.
  - `apps/api/src/common/i18n/` — `timezone.service.ts` (`TimezoneService`),
    `i18n-demo.controller.ts` (`GET /i18n/demo`), `i18n.module.ts`.
  - `apps/api/src/country-packs/country-packs.controller.ts` — `PUT
/country-packs/overrides/:countryCode` now `@AuditLog`'d, with an
    explicit `AuditCaptureService.setBefore()` call capturing the
    pre-upsert override row — the reference usage of the automatic-capture
    framework on a REAL sensitive mutation, not a synthetic demo.
  - `apps/api/src/notifications/notification-template-renderer.service.ts`
    — its private `substitute` method deleted; now calls `@hrm/shared`'s
    `interpolateTemplate` instead (behavior unchanged, one templating
    implementation instead of two).
  - `apps/api/src/app.module.ts` — registered `AuditModule`,
    `CustomFieldsModule`, `I18nModule`; `auth.module.ts`/
    `licensing.module.ts`/`workflow.module.ts` had their now-deleted
    placeholder listener registrations removed.
  - `apps/api/src/auth/auth-events.ts` / `licensing/licensing-events.ts` /
    `workflow/workflow-events.ts` — doc comments updated to point at
    `DomainEventAuditListener` instead of the deleted placeholder classes;
    no contract/behavior change.
  - `apps/portal/src/i18n/I18nProvider.tsx` /
    `apps/admin/src/i18n/I18nProvider.tsx` — byte-identical React i18n/RTL
    context providers (see Conventions for why duplicated rather than
    shared). Both apps' `layout.tsx` wrap `children` in `<I18nProvider>`
    with a safe `lang="en" dir="ltr"` initial `<html>`; both apps'
    `page.tsx` demonstrate `useI18n()` with a working locale-toggle button.
  - `packages/db/test/audit-log-immutability.spec.ts` — 5 integration
    tests (insert succeeds; update/delete rejected at the DB level with
    `permission denied`; RLS isolation; no tenant context fails loudly).
  - `apps/api/src/common/i18n/timezone.spec.ts` — 5 pure unit tests for
    `formatInTimeZone`/`toUtcIsoString`/`assertValidTimeZone`.
  - `apps/api/test/audit.e2e-spec.ts` — 7 integration tests over real HTTP
    (see Conventions → Audit log → Verified-by for the full list).
  - `apps/api/test/custom-fields.e2e-spec.ts` — 9 integration tests over
    real HTTP (definition validation, value validation, round trip,
    tenant isolation).
  - `apps/api/test/i18n-demo.e2e-spec.ts` — 3 integration tests over real
    HTTP (US branch en/LTR, Qatar branch ar/RTL, per-timezone rendering).
    **Bug caught and fixed while landing this step**: `AuditInterceptor`
    (used via `@UseInterceptors(AuditInterceptor)` from
    `country-packs.controller.ts`/`custom-fields.controller.ts`) initially
    failed to resolve its `AuditRecordService` dependency the moment
    `AppModule` compiled, because `AuditModule` wasn't `@Global()` — unlike
    `PermissionsGuard`, whose own dependencies (`Reflector`, and
    `TenantContextService` from the already-`@Global()` `TenancyModule`)
    happen to be globally available regardless of which module registers
    it, `AuditRecordService` had no such global source. This broke EVERY
    e2e suite (all of them boot the full `AppModule`), caught immediately
    by running the full suite before considering this step done. Fixed by
    adding `@Global()` to `AuditModule`, the same pattern `TenancyModule`
    already established for exactly this reason.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 24 new `apps/api` tests pass (7 audit + 9
    custom-fields + 3 i18n-demo + 5 timezone unit), all 124 pre-existing
    `apps/api` tests still pass with no behavior change (148 total), and
    all 14 `packages/db` tests pass (9 original RLS + 5 new
    audit-immutability) — 162 tests total, 17 `apps/api` suites in ~33s.
    One benign, pre-existing log line reappears in the full run (a
    `workflow.submitted` dispatch failing with a foreign-key error after
    `workflow.e2e-spec.ts`'s `afterAll` deletes its tenant) — the same
    test-teardown ordering artifact 0.8's build log entry already
    documents, unrelated to this step and never affecting an assertion.
    Full-repo `pnpm build` and `pnpm lint` both green across all 7
    workspaces. `apps/portal` and `apps/admin` both build and lint cleanly
    with the new provider wired into their root layouts.
- **0.10 resilience chassis — done — 2026-08-27.** The "degrades
  gracefully, never collapses" layer every Phase 1+ module inherits
  automatically: per-tenant rate limiting/quotas, circuit breakers +
  timeouts on outbound calls, load shedding by request priority,
  connection-pool exhaustion protection, a reusable idempotency
  primitive, and liveness/readiness + graceful shutdown. Full design in
  [`docs/conventions/resilience.md`](./conventions/resilience.md) —
  including the ordering bug caught and fixed while building this step
  (see below). **PHASE 0 (foundational chassis) IS NOW COMPLETE** — every
  future Phase 1+ module (Employee, Leave, Attendance, ESS/MSS,
  dashboard, ...) builds directly on top of tenancy/RLS (0.2), tenant
  resolution (0.3), auth/RBAC (0.4), country packs (0.5), licensing
  (0.6), workflow (0.7), notifications (0.8), audit/custom-fields/i18n
  (0.9), and this resilience chassis (0.10) — all six of 0.10's
  mechanisms apply to any new route/module with zero additional wiring,
  the same way RLS has applied to every table since 0.2. Files:
  - `packages/db/src/pool-config.ts` — `resolveAppPoolConfig`/
    `resolveAdminPoolConfig`/`withPoolParams`.
  - `packages/db/src/clients.ts` — both `prisma` and `appPrisma` now
    constructed with `datasourceUrl` built via `withPoolParams`, each
    against its own pool config; added the `ownerDatabaseUrl()` guard
    (matching `appDatabaseUrl()`'s existing "no missing_ok" posture) for
    `DATABASE_URL`, which previously had no explicit check.
  - `packages/db/src/index.ts` — exports `pool-config`.
  - `packages/shared/src/constants/rate-limits.ts` — `DEFAULT_RATE_LIMITS`
    by edition.
  - `packages/shared/src/resilience/` — `circuit-breaker.types.ts`
    (`CircuitState`, `CircuitBreakerOptions`, `DEFAULT_CIRCUIT_BREAKER_OPTIONS`),
    `priority.ts` (`RequestPriority`, `REQUEST_PRIORITIES`,
    `DEFAULT_REQUEST_PRIORITY`).
  - `packages/shared/src/validators/idempotency.validator.ts` —
    `idempotencyKeySchema`.
  - `apps/api/src/redis/rate-limiter.service.ts` — `RateLimiterService`/
    `TooManyAttemptsException`, MOVED here from `auth/` (no behavior
    change); `redis.module.ts` now provides/exports it, `@Global()`
    already applied.
  - `apps/api/src/resilience/rate-limit/` — `tenant-rate-limit.service.ts`
    (`TenantRateLimitService`), `rate-limit-admin.controller.ts`
    (`PATCH`/`GET`/`DELETE /platform/rate-limits/:tenantId`),
    `rate-limit-exception.filter.ts` (`RateLimitExceptionFilter`).
  - `apps/api/src/resilience/circuit-breaker/` —
    `circuit-breaker.service.ts` (`CircuitBreakerService`),
    `circuit-open.exception.ts` (`CircuitOpenError`).
  - `apps/api/src/resilience/load-shedding/` — `system-load.service.ts`
    (`SystemLoadService`), `priority.decorator.ts` (`@Priority()`),
    `load-shedding.service.ts` (`LoadSheddingService`, called directly
    from `TenantScopeInterceptor` — see Conventions for why this is NOT a
    separate `APP_INTERCEPTOR`, the ordering bug that proved it wrong).
  - `apps/api/src/resilience/idempotency/` — `idempotency.service.ts`
    (`IdempotencyService`), `idempotent.decorator.ts` (`@Idempotent()`),
    `idempotency.interceptor.ts` (`IdempotencyInterceptor`).
  - `apps/api/src/resilience/health/` — `readiness.service.ts`
    (`ReadinessService`), `health.controller.ts` (`GET /health/live`,
    `GET /health/ready`).
  - `apps/api/src/resilience/shutdown/shutdown.service.ts` —
    `ShutdownService`.
  - `apps/api/src/resilience/db-pool-exhaustion.filter.ts` —
    `DbPoolExhaustionFilter`.
  - `apps/api/src/resilience/demo/` — `flaky-dependency.service.ts`
    (`FlakyDependencyService`), `resilience-demo.controller.ts` (`GET
/resilience/demo/slow`, `POST /resilience/demo/flaky/configure`, `GET
/resilience/demo/breaker(/state)`, `POST /resilience/demo/idempotent`,
    `GET /resilience/demo/low-priority`, `GET /resilience/demo/critical`)
    — the reference/proof surface, same role every prior step's demo
    endpoints play.
  - `apps/api/src/resilience/resilience.module.ts` — `@Global()`,
    registers `RateLimitExceptionFilter`/`DbPoolExhaustionFilter` as
    `APP_FILTER`s and every resilience service/controller.
  - `apps/api/src/tenancy/tenant-scope.interceptor.ts` — EXTENDED again
    (0.4 added auth; this step adds load shedding, the request timeout,
    and the per-tenant rate-limit check, ALL directly in this one
    interceptor rather than as separate global interceptors — see
    Conventions "THE SPINE IS ONE INTERCEPTOR" for the empirically-proven
    reason).
  - `apps/api/src/auth/auth.controller.ts` — `login`/`refresh` now
    `@Priority('CRITICAL')`.
  - `apps/api/src/resilience/health/health.controller.ts` /
    `apps/api/src/app.controller.ts` — health routes now
    `@Priority('CRITICAL')`.
  - `apps/api/src/notifications/notification-delivery.service.ts` —
    provider `.send()` calls now wrapped in
    `circuitBreaker.execute('notification-provider:<channel>', ...)`; no
    other change to 0.8's retry/dead-letter logic.
  - `apps/api/src/app.module.ts` — registers `ResilienceModule`.
  - `apps/api/src/main.ts` — replaced `app.enableShutdownHooks()` with
    explicit `SIGTERM`/`SIGINT` handling (`ShutdownService.beginShutdown()`
    immediately, THEN a `SHUTDOWN_GRACE_PERIOD_MS` drain window, THEN
    `app.close()`) — see Conventions for why the default hook behavior
    doesn't give a load balancer time to react.
  - `packages/db/.env` / `.env.example`, `apps/api/.env` / `.env.example`
    — added `DB_POOL_SIZE`/`DB_ADMIN_POOL_SIZE`/`DB_POOL_TIMEOUT_SECONDS`
    (both packages, since both construct pooled clients) and, `apps/api`
    only, `REQUEST_TIMEOUT_MS`/`LOAD_SHED_LOW_THRESHOLD`/
    `LOAD_SHED_NORMAL_THRESHOLD`/`SHUTDOWN_GRACE_PERIOD_MS`.
  - `apps/api/test/resilience.e2e-spec.ts` (10 tests),
    `apps/api/test/resilience-pool-exhaustion.e2e-spec.ts` (1 test),
    `apps/api/test/resilience-request-timeout.e2e-spec.ts` (2 tests) — see
    Conventions → Verified-by for the full list and why these are three
    separate files.
    **Two real bugs caught and fixed while landing this step, both
    documented in Conventions above in full**: (1) load shedding/the
    request timeout, originally separate global `APP_INTERCEPTOR`s
    relying on module import order, actually landed NESTED INSIDE
    `TenantScopeInterceptor` instead of wrapping it — proven by an e2e
    test sending a shed request with an unresolvable tenant and getting
    401 instead of 503; fixed by folding both directly into
    `TenantScopeInterceptor` itself, guaranteeing the order by
    construction. (2) The pool-exhaustion e2e test itself was flaky/wrong
    at first because supertest/superagent `Request` objects are LAZY
    thenables — assigning one to a variable without a `.then()` doesn't
    dispatch it, so an intended concurrent "holder" request was actually
    sent only when finally `await`ed at the end of the test, well after
    the "contender" had already raced past it uncontested.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 13 new tests pass, all 148 pre-existing
    `apps/api` tests still pass with no behavior change (161 total), all
    14 `packages/db` tests still pass. Full-repo `pnpm build` and `pnpm
lint` both green across all 7 workspaces.
- **Docs reorganization — done — 2026-08-27.** No code/schema/test changes.
  Split the root `CLAUDE.md` (which had grown to ~2420 lines across 0.1–0.10)
  into a lean entry-point index plus this file (`docs/BUILD_LOG.md`, the full
  append-only build history) and one file per subsystem under
  `docs/conventions/` (all prior convention detail preserved verbatim, not
  summarized). `CLAUDE.md` itself now holds only: overview, non-negotiables,
  stack/workspace map, a docs index, a one-line-per-step build-log summary
  pointing here, and the Not-yet-built checklist (kept there since it's
  navigational). Two forward-looking notes flagged during Phase 0 but not
  previously written down were captured in their respective convention
  files: the transactional-outbox pattern as the eventual upgrade to 0.8's
  event-dispatch retry (in `docs/conventions/notifications-queues.md`), and
  the fixed-window rate-limit boundary-burst tradeoff from 0.10, with
  sliding-window/token-bucket noted as the stricter alternative (in
  `docs/conventions/resilience.md`). **Convention going forward: future
  steps append build-log detail here (`docs/BUILD_LOG.md`) and add/update
  the relevant `docs/conventions/*.md` file(s) — not back into `CLAUDE.md`.**
  See `CLAUDE.md`'s "How to use these docs" note.
  Verified: `pnpm build` (5/5 tasks), `pnpm lint` (7/7 tasks), and `pnpm
test` (all green, 175/175 — 161 `apps/api` + 14 `packages/db`, unchanged
  from before the reorg, since nothing but docs moved) all pass.
- **1.1 Employee module — done — 2026-08-27.** The first Phase 1 module —
  the core HR entity leave/attendance/payroll/performance/ESS-MSS will all
  reference. Full design in
  [`docs/conventions/employee.md`](./conventions/employee.md), including
  the workflow approver-rule seams it now feeds real data (the change
  0.7's own doc comment predicted). Files:
  - `packages/db/prisma/schema.prisma` — `Employee` (tenant-scoped, RLS;
    `userId` nullable/per-tenant-unique link to `User`; composite
    self-relation `managerId`; encrypted-at-rest
    `bankAccountNumberEncrypted`/`bankNameEncrypted`/
    `bankRoutingCodeEncrypted`/`baseSalaryEncrypted`; `statutoryFields`
    JSON map), `EmployeeDependent`, `EmployeeEmergencyContact`,
    `EmployeeDocument` (+ `EmployeeDocumentType` enum — metadata only, S3/
    MinIO holds the bytes), `EmployeeImportJob` (+ `EmployeeImportStatus`
    enum — bulk-import tracking), `EmploymentType`/`EmployeeStatus`/
    `Gender` enums, plus back-relations on `Tenant`/`User`/`Branch`/
    `Department`/`Designation` and a new `@@unique([tenantId, id])` on
    `Designation` (needed for the new composite FK from `Employee`, and
    the one gap left in that table's composite-FK-enabling-unique
    coverage since 0.2).
  - `packages/db/prisma/migrations/20260827125616_add_employee_module/` —
    the six enums and five tables (generated via `prisma migrate diff` +
    `migrate deploy`, same non-interactive method every prior step since
    0.4 documented; one empty stray migration folder from an aborted
    first attempt was created, applied, and then cleanly removed — folder
    deleted and its `_prisma_migrations` tracking row deleted directly —
    before this real migration was written, so the final migration
    history has no gap).
  - `packages/db/prisma/migrations/20260827125700_enable_rls_for_employee_module/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all five new tables, identical pattern to every other
    tenant-owned table (no exemption needed — an `Employee` row always
    belongs to exactly one tenant, nothing about resolving it needs to
    run before a tenant context exists).
  - `packages/shared/src/validators/employee.validator.ts` —
    `createEmployeeSchema`/`updateEmployeeSchema` (the first genuinely
    PARTIAL-update schema in this codebase — every prior PUT-style config
    used full-replace instead), `statutoryFieldsSchema`, `bankDetailsSchema`/
    `compensationSchema` (plaintext at the API boundary only),
    `employeeDependentSchema`/`employeeEmergencyContactSchema`,
    `employeeImportRequestSchema`, plus the
    `EMPLOYMENT_TYPES`/`EMPLOYEE_STATUSES`/`GENDERS`/
    `EMPLOYEE_DOCUMENT_TYPES` const-array/type-key pairs.
  - `packages/shared/src/audit/redact.ts` — `REDACTED_KEY_PATTERN`
    extended to also match `bankDetails`/`compensation` (whole container
    keys, not each leaf field) so a salary CHANGE is auditable without the
    actual value ever reaching `audit_log`.
  - `apps/api/src/common/encryption/encryption.service.ts` /
    `encryption.module.ts` — `EncryptionService` (AES-256-GCM,
    `FIELD_ENCRYPTION_KEY`-keyed), `@Global()` new reusable infra module,
    same posture as `QueueModule`/`AuditModule`.
  - `apps/api/src/storage/storage.service.ts` / `storage.module.ts` —
    `StorageService` (S3/MinIO client via `@aws-sdk/client-s3`), the FIRST
    real use of the `S3_*` env vars documented since 0.1; `@Global()`, same
    reusable-infra posture.
  - `apps/api/src/employees/` — `employee.service.ts` (`EmployeeService`,
    the CRUD + business-rule core, `tx`/`tenantId` taken explicitly so it
    works from both an HTTP request and the bulk-import worker),
    `employee-mapper.ts` (`EmployeeMapper`, assembles the full response
    DTO — decrypt, dependents/contacts, custom field values),
    `employee-response.dto.ts` (`EmployeeResponseDto`, `compensation`
    gated behind `salary.view` via `@RequiresPermission()` — the real,
    primary use of the pattern 0.4 built as a demo),
    `employee-country-pack.util.ts` (`resolveRequiredEmployeeFields`, the
    explicit-`tx` duplicate of `CountryPackResolutionService`'s
    branch→pack→override resolution), `org-chart.service.ts`
    (`OrgChartService`), `employee.constants.ts`, `employees.controller.ts`
    (`EmployeesController`, the full REST surface — see
    docs/conventions/employee.md § API surface), `employees.module.ts`;
    `documents/employee-documents.service.ts` /
    `employee-documents.controller.ts` (`EmployeeDocumentsService`/
    `EmployeeDocumentsController`, multipart upload via `FileInterceptor`,
    streamed download via `StreamableFile`); `import/csv-row.util.ts`
    (`parseEmployeeImportCsv`, reuses `createEmployeeSchema` per row),
    `employee-import.service.ts` (`EmployeeImportService`, the BullMQ
    producer — mirrors `NotificationsService.handleDomainEvent`'s shape),
    `employee-import.processor.ts` (`EmployeeImportProcessor`, the worker
    — one `withTenantContext` transaction PER ROW for genuine row-level
    isolation).
  - `apps/api/src/queue/queue.constants.ts` — new `EMPLOYEE_IMPORT_QUEUE`
    constant, registered via `BullModule.registerQueue()` in
    `employees.module.ts`, the same reusable pattern 0.8 established.
  - `apps/api/src/workflow/approver-resolver.service.ts` — `MANAGER`/
    `resolveRequesterBranchId`/`resolveRequesterDepartmentId` now query
    the real `Employee` org chart first, falling back to the legacy 0.7
    seams (`User.managerId`/the requester's sole `UserBranch` row) only
    for a requester with no `Employee` record at all — see
    docs/conventions/employee.md § Feeding the workflow engine for the
    exact before/after and why nothing that worked pre-1.1 regresses.
  - `apps/api/src/app.module.ts` — registers `EncryptionModule`,
    `StorageModule`, `EmployeesModule`.
  - `apps/api/package.json` — added `@aws-sdk/client-s3` (MinIO/S3
    client), `csv-parse` (bulk-import CSV parsing), `@types/multer` (dev,
    for `Express.Multer.File` typings needed by document upload) — none of
    these existed anywhere in the repo before this step.
  - `apps/api/.env` / `.env.example` — added `FIELD_ENCRYPTION_KEY`
    (base64-encoded 32-byte AES-256 key; a real local-dev value generated
    and committed to `.env`, consistent with this repo's other plaintext
    dev secrets — `.env.example` documents the var with an empty value and
    the regeneration command).
  - `apps/api/test/employees.e2e-spec.ts` — 15 integration tests over real
    HTTP, including real MinIO for document upload/download (not a mock)
    — see docs/conventions/employee.md § Verified-by for the full list.
    **Two real bugs caught and fixed while landing this step**: (1)
    spreading a `Partial<Prisma.EmployeeUpdateInput>`-typed helper's return
    value into a `create()` call's `data` object literal made TypeScript
    infer the WHOLE literal against Prisma's branded `X |
XFieldUpdateOperationsInput` union (Prisma's `{set: X}` update-operation
    syntax), breaking type-checking on every OTHER field in that object
    too — fixed by typing the shared encryption helper's return value as a
    plain, non-Prisma-branded interface instead of borrowing
    `Prisma.EmployeeUpdateInput`. (2) An update-path "is this `userId`
    already linked to a different employee" check had no way to
    distinguish "linked to THIS employee already" (fine, no-op) from
    "linked to a genuinely different one" (a real conflict), so
    re-submitting a `PATCH` with an employee's own already-linked `userId`
    unchanged would have falsely rejected — fixed by passing the
    in-progress update's own employee id through to that check so it can
    exclude itself.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379` / MinIO on `localhost:9000`: all 15 new tests pass,
    all 161 pre-existing `apps/api` tests still pass with no behavior
    change (176 total in `apps/api`; 190 including `packages/db`'s 14).
    Full-repo `pnpm build` (5/5), `pnpm lint` (7/7), `pnpm test` (4/4
    tasks) all green.
