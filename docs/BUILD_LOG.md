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
- **1.2 Leave module — done — 2026-08-27.** Consumes four Phase 0/1 systems
  rather than reimplementing any of them — the workflow engine (0.7) for
  approval, Country Packs (0.5) for entitlements/holidays/weekends, the
  Employee/manager relation (1.1) for approver resolution, and the 0.8
  BullMQ queue pattern for scheduled accrual. Full design in
  [`docs/conventions/leave.md`](./conventions/leave.md). Files:
  - `packages/db/prisma/schema.prisma` — `LeaveType` enum (ANNUAL/SICK/
    MATERNITY/PATERNITY — a CLOSED catalog mirroring `CountryPackConfig.
leaveDefaults`' four fixed keys, not a free-form `entityType` string, the
    same "some things ARE a fixed set" exception `CustomFieldType` already
    takes), `LeaveRequestStatus` enum, `LeaveBalance` (one row per
    employee/leaveType/calendar-year, `entitledDays` a snapshot of the
    resolved pack+override entitlement, `accruedDays`/`carriedOverDays`/
    `usedDays` — available balance is `accruedDays + carriedOverDays -
usedDays`, derived at read time, never stored), `LeaveRequest`
    (`workflowInstanceId` a plain UUID reference — no FK — to the
    `WorkflowInstance` it started, `balanceApplied` guards the workflow-
    event listener against double-deducting), `LeaveAccrualRun` (one row
    per employee/leaveType/calendar-month the accrual worker has
    processed — the DB-layer half of accrual idempotency), plus back-
    relations on `Tenant`/`Employee`.
  - `packages/db/prisma/migrations/20260827184026_add_leave_module/` — the
    two enums and three tables (generated via `prisma migrate diff` +
    `migrate deploy`; the SAME stray-empty-migration-folder situation 1.1
    hit recurred on the first `migrate diff` attempt — folder deleted, its
    `_prisma_migrations` row deleted directly, before the real migration
    was written).
  - `packages/db/prisma/migrations/20260827184100_enable_rls_for_leave_module/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all three new tables, identical pattern to every other
    tenant-owned table.
  - `packages/shared/src/validators/leave.validator.ts` — `LEAVE_TYPES`/
    `LEAVE_REQUEST_STATUSES` const-array/type-key pairs,
    `createLeaveRequestSchema` (`.strict()` + a `.refine()` that
    `endDate >= startDate`), `adjustLeaveBalanceSchema`,
    `runLeaveAccrualSchema`.
  - `packages/shared/src/constants/permissions.ts` — three new permissions
    (`leave.read`/`leave.write`/`leave.approve`), seeded onto
    `HR_MANAGER`/`MANAGER` (all three) and `EMPLOYEE` (read + write only,
    self-service) — `TENANT_ADMIN` already gets everything via
    `ALL_PERMISSIONS`.
  - `apps/api/src/leave/` — `leave-country-pack.util.ts`
    (`resolveLeavePackConfig`, the explicit-`tx` duplicate of
    `CountryPackResolutionService`'s branch→pack→override resolution, the
    SAME pattern `employee-country-pack.util.ts` (1.1) established, needed
    here for the SAME reason: this module's entitlement/day-count
    resolution runs from both an HTTP request and the accrual worker),
    `leave-day-calculator.ts` (`countBusinessDays`, pure/UTC-safe weekend +
    public-holiday exclusion), `leave-entitlement.util.ts`
    (`entitlementForType`, the one place that maps a `LeaveType` to its
    `leaveDefaults` key), `leave-balance.service.ts` (`LeaveBalanceService`
    — balance row lifecycle: get-or-create with a snapshotted entitlement,
    deduct/restore/adjust), `leave-response.dto.ts`, `leave.service.ts`
    (`LeaveService` — submit/list/get/balances/calendar/conflicts; submit
    checks the balance BEFORE creating anything, then starts a real
    `WorkflowInstance` via `WorkflowEngineService.startInstance` — no
    bespoke approval logic at all), `leave-workflow-events.listener.ts`
    (`LeaveWorkflowEventsListener`, subscribes to the workflow engine's own
    `workflow.approved`/`workflow.rejected`/`workflow.canceled` events
    filtered to `entityType === "LeaveRequest"` — the ONLY leave-specific
    reaction to the generic engine, applying the balance deduction/
    restore side-effect it has no way to know about itself), `leave.
constants.ts`, `leave.controller.ts` (`LeaveController` — deliberately NO
    approve/reject/cancel route; those are the generic 0.7 workflow
    routes), `leave.module.ts`; `accrual/leave-accrual.service.ts`
    (`LeaveAccrualService`, the BullMQ producer — `POST /leave/accrual/run`
    is today's manual trigger, not wired to a real cron yet, the same
    documented tradeoff 0.7's `WorkflowEscalationService.
sweepOverdueSteps` already takes), `accrual/leave-accrual.processor.ts`
    (`LeaveAccrualProcessor`, the worker — iterates a tenant's `ACTIVE`
    employees, wraps each employee/leaveType/period unit in
    `IdempotencyService.execute()` — 0.10's Redis-backed primitive, called
    directly rather than via the HTTP-only `@Idempotent()` decorator, plus
    the `LeaveAccrualRun` unique constraint as a DB-layer backstop),
    `accrual/leave-proration.util.ts` (`prorationFactorForJoinMonth` — a
    mid-month joiner accrues only the remaining days of that month; a
    future-dated joiner accrues nothing for a not-yet-started period).
  - `apps/api/src/queue/queue.constants.ts` — new `LEAVE_ACCRUAL_QUEUE`
    constant, registered via `BullModule.registerQueue()` in
    `leave.module.ts`, the same reusable pattern 0.8/1.1 established.
  - `apps/api/src/app.module.ts` — registers `LeaveModule`.
  - `apps/api/test/leave.e2e-spec.ts` — 13 integration tests over real
    HTTP — see docs/conventions/leave.md § Verified-by for the full list.
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379`: all 13 new tests pass, all 176 pre-existing
    `apps/api` tests still pass with no behavior change (189 total in
    `apps/api`; 203 including `packages/db`'s 14). Full-repo `pnpm build`
    (5/5), `pnpm lint` (7/7), `pnpm test` (4/4 tasks) all green.
- **1.3 Attendance & time-tracking module — done — 2026-08-28.** The first
  HIGH-VOLUME module — designed partition-ready and timezone-correct from
  day one. Consumes Country Packs (0.5) for weekend/holiday/overtime rules,
  the Employee/manager relation (1.1) for approver resolution, the workflow
  engine (0.7) for regularization approval, and the 0.8 BullMQ pattern for
  the summary-computation job — no Phase 0/1 mechanism was reimplemented or
  modified. Full design in
  [`docs/conventions/attendance.md`](./conventions/attendance.md). Files:
  - `packages/db/prisma/schema.prisma` — `Branch` gains three nullable
    geo-fence columns (`geofenceLat`/`geofenceLong`/`geofenceRadiusMeters`
    — all null means geo-fencing is OFF for that branch), the SAME "small
    nullable seam column on an existing Phase-0 model" pattern 0.7 used for
    `headUserId`. New enums `AttendanceSource`/`AttendanceRecordStatus`/
    `AttendanceRegularizationStatus`/`AttendanceDayStatus`. `ShiftDefinition`
    (tenant-scoped shift template, "HH:mm" start/end, `crossesMidnight`
    denormalized at write time) and `RosterAssignment` (employee ->
    shift for a date range, "most recent assignment covering this date
    wins" resolution). `AttendanceRecord` — the high-volume table, PARTITION-
    READY exactly like `AuditLog` (0.9): composite PRIMARY KEY
    `(id, workDate)`, `workDate` (the branch-local working day, resolved
    ONCE at clock-in and frozen — never recomputed at clock-out) as the
    intended partition key, `tenantId`-leading indexes only, and
    DELIBERATELY no `@@unique([tenantId, id])` (would violate the Postgres
    partitioning rule that every unique constraint must include the
    partition key) — so `shiftDefinitionId` on this table and
    `attendanceRecordId` on `AttendanceRegularization` are both plain UUID
    columns with no FK relation, the same "just an id" pattern
    `WorkflowInstanceStep.delegatedToUserId`/`LeaveRequest.
workflowInstanceId` already use. `AttendanceRegularization` (ordinary,
    NOT partitioned — ties into 0.7 via `workflowInstanceId`, a plain UUID
    reference, no bespoke approval state). `AttendanceDailySummary` — the
    precomputed reporting surface (one row per employee/day,
    `@@unique([tenantId, employeeId, workDate])`) team/period reports read
    exclusively, so a report never aggregates `AttendanceRecord` directly.
    Plus back-relations on `Tenant`/`Employee`/`Branch`.
  - `packages/db/prisma/migrations/20260828105625_add_attendance_module/`
    — generated via `prisma migrate dev` against local Postgres; the
    `attendance_records` `CREATE TABLE` was inspected directly to confirm
    `PRIMARY KEY ("id","work_date")`, no bare `id` unique constraint.
  - `packages/db/prisma/migrations/20260828105700_enable_rls_for_attendance_module/`
    — `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation`
    policy on all five new tables, identical pattern to every other
    tenant-owned table; this migration does not touch the partition-ready
    shape itself.
  - `packages/shared/src/validators/attendance.validator.ts` — closed
    source/status/day-status catalogs (`ATTENDANCE_SOURCES`/
    `ATTENDANCE_RECORD_STATUSES`/`ATTENDANCE_REGULARIZATION_STATUSES`/
    `ATTENDANCE_DAY_STATUSES`), `clockInSchema`/`clockOutSchema` (validate
    the PARSED multipart body — an optional selfie is a real `FileInterceptor`
    upload, the SAME "binary content doesn't fit JSON" posture 1.1's
    document upload established; `source` is restricted to `WEB`/`MOBILE` —
    `BIOMETRIC`/`MANUAL` are set only internally, never client-supplied),
    `manualPunchSchema` (the biometric-seam demo route),
    `createShiftDefinitionSchema`/`createRosterAssignmentSchema`,
    `createRegularizationSchema`, `runAttendanceSummarySchema`,
    `branchGeofenceSchema`.
  - `packages/shared/src/constants/permissions.ts` — four new permissions
    (`attendance.read`/`attendance.write`/`attendance.approve`/
    `attendance.regularize`), seeded onto `HR_MANAGER`/`MANAGER` (all four)
    and `EMPLOYEE` (read/write/regularize, self-service — no approve);
    also seeds the pre-existing-but-previously-unused `branch.manage`
    (0.4) onto `HR_MANAGER`, now consumed for the first time by the
    branch geo-fence config route.
  - `apps/api/src/attendance/attendance-timezone.util.ts` — the ONE place
    this module does real timezone MATH (not just rendering, which
    `@hrm/shared`'s `formatInTimeZone` already covers): `toBranchLocal`
    (UTC instant -> branch-local calendar date + minutes-of-day, via
    `Intl.DateTimeFormat.formatToParts`, never string-parsing a rendered
    date), `resolveWorkDate` (the crossing-midnight day-attribution rule —
    a clock-in before a crossing shift's end time rolls back to the
    PREVIOUS calendar day), `branchLocalToUtc` (the reverse conversion,
    via iterative offset correction, used to turn a shift's scheduled
    start into a real instant for lateness comparison).
  - `apps/api/src/attendance/attendance-metrics.util.ts` —
    `computeRecordMetrics`, the ONE function shared by clock-out and
    regularization-approval for worked/overtime/late minutes, entirely
    pack-driven (`overtimeRules.dailyThresholdHours`) — THE RULE holds, no
    country-code branch anywhere. `weeklyThresholdHours` aggregation is a
    documented, out-of-scope simplification for this step.
  - `apps/api/src/attendance/attendance-country-pack.util.ts` —
    `resolveAttendancePackConfig`, the explicit-`tx` duplicate of
    `CountryPackResolutionService`'s branch->pack->override resolution
    (the SAME pattern `leave-country-pack.util.ts`/`employee-country-pack.
util.ts` established), needed here for the SAME reason: this module's
    weekend/holiday/overtime resolution runs from both an HTTP request and
    the context-less summary worker.
  - `apps/api/src/attendance/attendance-scope.util.ts` — the branch-
    scoping/self-vs-other-employee resolution helpers, duplicated from the
    private methods `LeaveService` (1.2) already established (reuse the
    pattern, not the file).
  - `apps/api/src/attendance/geofence.util.ts` — `haversineDistanceMeters`/
    `isWithinGeofence`; a branch with all three geo-fence columns null has
    geo-fencing OFF entirely.
  - `apps/api/src/attendance/clock/attendance-clock.service.ts` —
    `AttendanceClockService`: `clockIn`/`clockOut` (HTTP-facing, resolve
    the caller's own or an explicitly permitted employee) delegate to
    `clockInForEmployee`/`clockOutForEmployee` (ALSO used directly by the
    biometric device seam, which has already resolved a specific employee
    and has no "caller" concept). Enforces "at most one OPEN record per
    employee" at the application layer (Prisma's schema DSL cannot express
    a partial-unique index), geo-fencing (only for `WEB`/`MOBILE` sources —
    a physical device already enforces presence by construction), resolves
    the shift/workDate via `ShiftResolutionService.resolveForClockIn` at
    clock-in and NEVER recomputes it at clock-out (closes the SAME open
    record instead) — this is what makes a shift crossing midnight
    attribute correctly to one working day regardless of which local
    calendar date the clock-out happens on.
  - `apps/api/src/attendance/shifts/shift-resolution.service.ts` —
    `ShiftResolutionService.resolveForDate` (plain roster lookup) and
    `.resolveForClockIn` (the real day-attribution algorithm: checks
    YESTERDAY's roster first via `resolveWorkDate`, only falling back to
    today's own roster when that doesn't apply — correctly handles even a
    SINGLE-DAY roster assignment for a crossing-midnight shift, not just a
    multi-day continuous range).
  - `apps/api/src/attendance/shifts/shifts.service.ts` +
    `shifts.controller.ts` — plain CRUD for `ShiftDefinition`/
    `RosterAssignment`, no workflow/approval involvement (an ordinary HR
    operation, unlike regularization).
  - `apps/api/src/attendance/devices/biometric-device.interface.ts` +
    `manual-biometric-device.adapter.ts` — the biometric/attendance-device
    SEAM, the SAME "swap one DI binding, no caller changes" pattern 0.4's
    `AUTH_PROVIDER`/0.8's `NotificationProvider`s establish.
    `ManualBiometricDeviceAdapter` (today's only binding) resolves a
    device's `employeeCode` to a real `Employee` and delegates straight to
    `AttendanceClockService`'s lower-level methods, tagged source
    `BIOMETRIC` — exercised via `POST /attendance/devices/manual-punch`.
    No real device protocol exists yet, by design — this step is the seam
    only.
  - `apps/api/src/attendance/regularization/` —
    `attendance-regularization.service.ts` (`AttendanceRegularizationService.
submit` — THE RULE applied exactly like `LeaveService`: creates the row,
    then hands off completely to `WorkflowEngineService.startInstance`, no
    approve/reject logic of its own), `attendance-regularization.
controller.ts` (deliberately NO approve/reject/cancel route — those are
    0.7's generic workflow routes), `attendance-regularization-workflow-
events.listener.ts` (`AttendanceRegularizationWorkflowEventsListener`,
    reacting to `workflow.approved`/`.rejected`/`.canceled` filtered to
    `entityType === "AttendanceRegularization"` — the ONLY place this
    module mutates an actual `AttendanceRecord`: patches an existing
    record's `clockInAt`/`clockOutAt` and recomputes metrics via
    `computeRecordMetrics`, or — when `attendanceRecordId` was omitted at
    submission (a fully missing punch) — creates a brand-new record on the
    regularization's own `workDate`, tagged source `MANUAL`).
  - `apps/api/src/attendance/summary/` — `attendance-day-status.util.ts`
    (`isWeekend`/`isPublicHoliday`, pure pack-driven derivation, the SAME
    approach `leave-day-calculator.ts` already established),
    `attendance-summary.service.ts` (`AttendanceSummaryService` — the
    BullMQ producer, plus `report()`, the READ side of the precomputed
    surface team/period reports use exclusively), `attendance-summary.
processor.ts` (the worker — classifies each employee/day as WEEKEND/
    HOLIDAY/ON_LEAVE/ABSENT/PRESENT/LATE and `upsert`s the summary row; a
    plain recompute, so re-running it is naturally idempotent with no
    separate idempotency layer needed, unlike 1.2's additive accrual).
  - `apps/api/src/attendance/attendance-response.dto.ts`,
    `attendance.constants.ts`, `attendance.controller.ts` (clock-in/out,
    record reads, the geo-fence config route, the biometric demo route,
    the summary-run trigger and report read), `attendance.module.ts`.
  - `apps/api/src/queue/queue.constants.ts` — new `ATTENDANCE_SUMMARY_QUEUE`
    constant, registered via `BullModule.registerQueue()` in
    `attendance.module.ts`, the same reusable pattern 0.8/1.1/1.2
    established.
  - `apps/api/src/app.module.ts` — registers `AttendanceModule`.
  - Five unit/integration spec files (33 tests, no HTTP bootstrap needed):
    `attendance-timezone.util.spec.ts`, `attendance-metrics.util.spec.ts`,
    `geofence.util.spec.ts`, `summary/attendance-day-status.util.spec.ts`
    (all pure-function, deterministic), and `shifts/shift-resolution.
service.spec.ts` (real Postgres, the SAME pattern `notification-locale-
resolver.service.spec.ts` (0.8) established — proves the crossing-
    midnight day-attribution rule precisely for two DIFFERENT branch
    timezones, including a SINGLE-DAY roster assignment, without any
    wall-clock dependency).
  - `apps/api/test/attendance.e2e-spec.ts` — 18 integration tests over
    real HTTP — see docs/conventions/attendance.md § Verified-by for the
    full list (clock in/out incl. geo-fence enforcement and selfie
    capture; the SAME summary job resolving WEEKEND for a QA employee vs.
    ABSENT for a US employee on the same Friday; a regularization running
    through the real 0.7 workflow to the real 1.1 manager with correct
    overtime computed on approval and no record created on rejection; the
    biometric device seam; RBAC deny-by-default; branch scoping;
    cross-tenant isolation; and the partition-ready composite-PK +
    tenantId-leading-index shape verified directly against
    `information_schema`/`pg_indexes`).
    Verified against local Postgres on `localhost:5433` / Redis on
    `localhost:6379` / MinIO on `localhost:9000`: all 51 new tests pass
    (33 unit/integration + 18 e2e), all 189 pre-existing `apps/api` tests
    still pass with no behavior change (240 total in `apps/api`; 254
    including `packages/db`'s 14). Full-repo `pnpm build` (5/5), `pnpm
lint` (7/7) both green; `pnpm test` passed in full when run
    `--runInBand` (the convention every e2e file in this suite already
    documents for itself) — the default parallel-worker `pnpm test` run
    intermittently hit one PRE-EXISTING, unrelated flake in `employees.
e2e-spec.ts`'s bulk-import polling test under shared-infra contention
    across concurrently-running e2e files (reproduced failing once, then
    passing on an immediate re-run with zero code changes in between,
    confirming it's parallelism-timing flakiness, not a regression).
- **1.4 ESS/MSS self-service UI — done — 2026-08-28.** A pure CONSUMPTION
  layer surfacing 0.4/0.5/0.7/0.8/1.1/1.2/1.3 through real UI on the tenant
  portal (`apps/portal`, Next.js 14 App Router) and a new mobile app
  (`apps/mobile`, React Native/Expo) — no Phase 0/1 module's business logic
  changed, only two small, additive backend reads/writes (below). Full
  design in
  [`docs/conventions/frontend-ess-mss.md`](./conventions/frontend-ess-mss.md).
  Files:
  - **Two minimal backend additions** (the only apps/api changes this
    step): `GET /employees/me` (`apps/api/src/employees/employee.service.ts`'s
    `findOwn` + a new controller route, registered before `:id`) — the one
    genuinely missing read (no existing route can answer "which Employee
    is the caller" on its own), branch-scope-bypassed since a caller's own
    record is never out of their own scope. `POST /auth/push-token`
    (`apps/api/src/auth/auth.controller.ts`, `setPushTokenSchema` in
    `@hrm/shared`) + a new nullable `User.pushToken` column
    (`packages/db/prisma/migrations/20260828123959_add_user_push_token/`)
    — registers/clears the caller's own push device token, now read by
    `NotificationDeliveryService` as the real `PUSH`-channel `to` address
    (falling back to the old placeholder when absent) — `LogPushProvider`
    itself is unchanged, still dev/log-only.
  - `packages/shared/src/i18n/messages.ts` — the `UI_MESSAGES` catalog
    grown from 9 keys to the full ESS/MSS vocabulary (profile/leave/
    attendance/approvals/notifications/announcements/settings/auth/common),
    in BOTH `en` and `ar` — no new mechanism, reusing 0.9's `translate()`/
    `interpolateTemplate`.
  - **`apps/portal`** (Next.js 14 App Router, new): Tailwind CSS + a
    distinct "grounded teal" design system (`tailwind.config.ts`,
    `globals.css`, `next/font/google` Inter + Noto Kufi Arabic);
    `lib/tenant.ts` (subdomain-mirroring in production, `x-tenant-id`
    header fallback for local dev — the SAME strategy 0.3 built for
    clients with no per-tenant hostname); `lib/auth/` (two-token model,
    in-memory access token, `localStorage` refresh token, single-in-
    flight-dedup 401 refresh retry in `lib/api/client.ts`);
    `lib/session/SessionProvider.tsx` (resolves the caller's own Employee
    - effective Country Pack ONCE per session — the first real feed into
      `I18nProvider`'s `rtl`/`locale` override props, with zero changes to
      that existing component); `lib/api/*.ts` (thin typed wrappers per
      endpoint); `components/ui/*` (Button/Card/Badge/Field/Modal/Alert/
      EmptyState/Spinner — logical-property (`ms-`/`me-`/`ps-`/`pe-`/
      `text-start`) Tailwind classes throughout, no RTL plugin needed);
      `components/layout/{Sidebar,Topbar}.tsx`; full screen set under
      `app/(app)/{dashboard,profile,leave,attendance,approvals,team,
org-chart,notifications,announcements,settings}` plus `app/login`.
      `/approvals` and `/team` consume ONLY the generic 0.7 workflow routes
      and 1.2/1.3's existing read routes — zero new backend routes for
      MSS. `docs/conventions/i18n-timezone-rtl.md`'s `I18nProvider` itself
      was NOT modified — `(app)/layout.tsx` mounts a second, nested instance
      fed real resolved values, gated behind a `ready` flag (a gotcha: the
      provider's `locale`/`rtl` props are read only on ITS OWN initial
      mount, so the mount itself had to be deferred, not the props pushed
      through after).
  - **`apps/portal/tests/`** — a Playwright suite (`playwright.config.ts`,
    `global-setup.ts` seeding two real tenants/branches/roles/Country
    Packs/workflow templates via `@hrm/db`'s own seed helpers and real
    argon2-hashed passwords). 14 tests across `auth.spec.ts` (login via
    the header strategy, wrong-password generic error, a hard reload
    surviving via a REAL `/auth/refresh` round-trip since the access
    token is memory-only, sign-out), `ess.spec.ts` (leave submission
    creates a real `WorkflowInstance`; clock-in creates a real `OPEN`
    `AttendanceRecord` tagged `WEB`), `mss.spec.ts` (approving from the
    inbox drives the real workflow to `APPROVED` AND the real
    `LeaveBalance.usedDays` deduction, polled per 1.2's own async-listener
    posture), `rbac.spec.ts` (a plain employee sees no "Team" nav entry,
    gets a graceful notice not a crash at `/team`), `rtl.spec.ts` (a
    QA-branch employee renders `dir="rtl" lang="ar"`, a US-branch
    employee `dir="ltr" lang="en"`, identical component tree), and
    `tenant-isolation.spec.ts` (workspace-slug login switches tenants
    with zero leakage; a real branch-restricted `UserBranch` row hides a
    QA-branch report from a US-restricted manager's org chart).
  - **`apps/mobile`** (new workspace, React Native/Expo, TypeScript,
    Expo SDK 57): scope is ESS + clock-in + push ONLY, no MSS, per this
    step's own brief. `src/lib/tenant.ts` (mobile has no hostname of its
    own at all — ALWAYS the `x-tenant-id` header strategy, unlike the
    portal's subdomain-first approach), `src/lib/auth/` (refresh token in
    `expo-secure-store`, mirroring the portal's in-memory-access-token +
    single-flight-refresh pattern), `src/i18n/` (the `UI_MESSAGES`/RTL
    catalog duplicated as plain TS per the SAME precedent
    `I18nProvider.tsx`'s cross-app duplication already sets — Metro/pnpm
    workspace resolution of a hoisted source package added real friction
    for content this small and stable), `src/i18n/useRtlSync.ts` (RTL on
    React Native is NOT a live flip like the web — `I18nManager.forceRTL`
    only takes effect from the NEXT launch, so this resolves the same
    authoritative Country-Pack `locale.rtl` signal and triggers ONE
    `Updates.reloadAsync()` when it disagrees with the current native
    flag — a documented, accepted platform difference), full ESS screen
    set (profile view/edit, leave apply/balances/history, attendance
    clock-in/out via `expo-location`/`expo-image-picker` with
    `source: 'MOBILE'` — the entire reason that enum value exists —
    regularization, notifications, the announcements seam, settings),
    `src/lib/push.ts` (`expo-notifications` + `expo-device`, registers a
    real Expo push token against the new `POST /auth/push-token` on
    login/rotation and deregisters on logout — delivery itself still goes
    through the backend's dev/log-only `LogPushProvider`, a real
    FCM/Expo-push-API provider is separate future work), `src/theme/tokens.ts`
    (the portal's exact color palette, ported to plain RN `StyleSheet`
    constants for visual consistency, no NativeWind). `apps/mobile/package.json`'s
    `build` script is `expo export --platform android --platform ios`
    (not the default `ios,android,web`) — this app was never asked to run
    in a browser, and the default would otherwise fail requiring
    `react-native-web` for a platform nobody requested; caught by running
    the real root `pnpm build` via Turborepo, not just the app's own
    scripts in isolation. `pnpm-workspace.yaml`/`turbo.json` needed ZERO
    changes — the `apps/*` glob auto-registered it and its `build`/`lint`/
    `test` npm scripts already match Turbo's existing task names.
  - Verified: `apps/api` grew by 4 tests (2 for `GET /employees/me`'s
    happy path + 404, 2 for `POST /auth/push-token`'s set/clear + deny-
    unauthenticated) to 244, all passing; `packages/db`'s 14 unchanged —
    258 total backend tests, zero regressions. `apps/portal`'s 14
    Playwright tests all pass against real Postgres/Redis/MinIO and a
    real running API. `apps/mobile`'s 19 Jest tests (pure-logic: i18n
    catalog/RTL helpers, the API client's URL/header/401-refresh logic)
    pass; `npx tsc --noEmit` and `npx eslint .` both clean; `npx
expo-doctor` 21/21; `npx expo export --platform android --platform ios`
    produces real Metro bundles for both platforms — the closest thing to
    a build-verification smoke test available in a sandbox with no
    simulator/device/EAS tooling (explicitly NOT claimed: any on-device or
    visual verification, since none was possible here). Full-repo `pnpm
build` and `pnpm lint` both green across all SEVEN workspaces (the six
    from before plus `@hrm/mobile`), confirmed via Turborepo, not just
    each package's scripts run in isolation.

- **1.5 Analytics dashboard — done — 2026-08-31. PHASE 1 COMPLETE.** The
  final Phase 1 step: a read-only KPI dashboard on the tenant portal,
  backed entirely by precomputed rollup tables computed by a real
  SCHEDULED BullMQ job — the codebase's first genuine cron, not another
  "manual trigger only" gap. Full design in
  [`docs/conventions/analytics-dashboard.md`](./conventions/analytics-dashboard.md).
  Files:
  - **`packages/db`**: one additive column,
    `Employee.terminatedAt DateTime?` (migration
    `20260831104151_add_analytics_module`) — set by
    `EmployeeService.update` the moment `status` transitions INTO
    `TERMINATED`, cleared on a reactivation out of it; the narrow capture
    fix for leave.md's long-documented "no termination date" gap, needed
    for leaver/attrition KPIs. Four new tenant-scoped rollup tables, RLS
    enabled by the matching `20260831104200_enable_rls_for_analytics_module`
    migration: `HeadcountDailySnapshot` (point-in-time cross-section, by
    branch/department/employmentType/gender), `WorkforceMovementDailyCount`
    (JOINER/LEAVER, one row per calendar day), `AttendanceDailyBranchSummary`
    (a rollup OF 1.3's own `AttendanceDailySummary` rollup — never touches
    raw `AttendanceRecord`), `LeaveUtilizationDailySnapshot` (rolled up
    from current-year `LeaveBalance`). Every index leads with `tenant_id`.
    `departmentId` is nullable on all four — Postgres treats every `NULL`
    as distinct in a unique index, so the rollup job DELETES the existing
    rows for `(tenantId, theDate)` and bulk-`createMany`s fresh ones every
    run, rather than upserting by the documented `@@unique` grain (a real
    gotcha, called out in the schema doc comments and in the conventions
    doc).
  - **`packages/shared`**: `PERMISSIONS.ANALYTICS_READ` (`analytics.read`),
    seeded onto `HR_MANAGER`/`MANAGER` (plus `TENANT_ADMIN` via
    `ALL_PERMISSIONS` as always) — a manager+ feature with no "view your
    own" carve-out, since there's no per-employee row to narrow to, only
    branch scope. `validators/analytics.validator.ts`
    (`runAnalyticsRollupSchema`). `i18n/messages.ts` grows an `analytics.*`
    block in both `en`/`ar`, plus `nav.analytics`/`common.type`.
  - **`apps/api/src/analytics`** (new module): `rollup/analytics-rollup.util.ts`
    (pure aggregation functions, DB-independent, unit-tested directly —
    `analytics-rollup.util.spec.ts`, 9 tests); `rollup/analytics-rollup.service.ts`
    (producer; `onModuleInit` registers ONE repeatable BullMQ job via the
    plain `repeat: { pattern }` option — already available in the pinned
    `bullmq@^5.28.2`, no new infra — that fans out one `rollup-tenant` job
    per `TRIAL`/`ACTIVE` tenant, discovered via the OWNER `prisma` client,
    same posture `ReadinessService` already takes for its own
    infrastructure-only DB check); `rollup/analytics-rollup.processor.ts`
    (worker; computes all four rollup tables for one tenant/one date per
    job, each a context-less `withTenantContext` transaction, same shape
    every Phase 1 processor already takes); `dashboard/analytics-dashboard.service.ts`
    (read side — reads ONLY the four rollup tables, branch-scoped the same
    two-layer way `AttendanceSummaryService.report` already is: an
    out-of-scope `branchId` filter returns an empty/zero dashboard, never
    a 403); `analytics.controller.ts` (`GET /analytics/dashboard`,
    `POST /analytics/rollup/run` — a manual backfill/test lever alongside
    the module's own real schedule, both gated by `analytics.read`).
  - **`apps/portal`**: new `/analytics` screen (nav entry in the "Team"
    sidebar group, gated by `can(PERMISSIONS.ANALYTICS_READ)`) — branch +
    date-range filters, KPI tiles (headcount/joiners/leavers/attrition
    rate/attendance rate), a headcount-by-branch bar chart and an
    attendance trend line chart (new dependency: `recharts`, no chart lib
    existed in this app yet), employment-type/gender breakdown lists (the
    diversity-split KPI), and a leave-utilization-by-type table — all
    locale/currency-free-number-formatted via the existing `lib/format.ts`
    (`formatPercent` added there), reusing the 1.4 design system
    (`Card`/`Field`/`EmptyState`/`Spinner`/`Alert`) with no new UI
    primitives. `lib/api/analytics.ts` + a plain `AnalyticsDashboard`
    interface in `lib/api/types.ts` (this codebase's established
    "duplicate the response shape as a plain interface" convention).
  - **Scope discipline**: no existing module's business logic, RLS, or
    auth changed. `packages/db`'s only other-module touch is the single
    additive `Employee.terminatedAt` column (plus its one-branch capture
    site in `EmployeeService.update`) — the same "small nullable seam
    column, tiny capture site" pattern 0.7/0.8/1.3 already established for
    `Branch.headUserId`/`User.pushToken`/`Branch.geofenceLat`.
  - Verified end to end by `apps/api/test/analytics.e2e-spec.ts` (5 tests:
    KPI numbers computed correctly from seeded employees/leave/attendance
    across two branches; **a direct, not just trusted, proof that
    dashboard reads are rollup-only** — every Employee row for the tenant
    is deleted after the rollup runs, and the dashboard's response is
    byte-identical before and after, since none of the four rollup tables
    carry an FK to `Employee`; branch-scoped visibility incl. an
    out-of-scope filter returning zeros, not a 403; RBAC deny-by-default;
    cross-tenant isolation via RLS) plus `analytics-rollup.util.spec.ts`
    (9 pure-function tests) — 272 backend tests total (258 + 14 new),
    zero regressions. `apps/portal` grows to 17 Playwright tests
    (`analytics.spec.ts`, 3 new: tenant-wide KPIs summed correctly across
    branches for an unrestricted manager, a branch-restricted manager
    seeing fewer than the tenant-wide view, and a plain employee getting
    a graceful notice rather than a crash) — rollup rows seeded directly
    into the four tables by `global-setup.ts` rather than via the real
    BullMQ job, since this suite's job is proving the UI renders rollup
    data correctly (and respects RBAC/branch-scope/locale), not
    re-proving the rollup computation itself. Full-repo `pnpm build`/
    `pnpm lint` green across all seven workspaces; `apps/mobile` untouched
    by this step.

- **2.1 Payroll module — done — 2026-08-31. Phase 2's first step.** THE
  HIGHEST-RISK MODULE in this codebase — full design in
  [`docs/conventions/payroll.md`](./conventions/payroll.md), including THE
  BOUNDARY statement ("the engine computes strictly what the resolved
  Country Pack declares; pack legal correctness is a per-country authoring
  responsibility"), the variable-semantics decisions, and two real
  correctness bugs caught and fixed during this step (the annualize/
  de-annualize tax pitfall, and the tiered-gratuity cumulative-vs-
  incremental double-counting trap). Files:
  - **`packages/db`**: `Tenant.baseCurrencyCode` (additive, defaults
    `"USD"`). New tables: `PayrollComponentDefinition` (salary structure —
    earnings/allowances/discretionary deductions ONLY, never a substitute
    for pack-driven tax/statutory), `ExchangeRate` (global, RLS-exempt like
    `CountryPack`), `PayrollRun` (`@@unique([tenantId, branchId,
periodYear, periodMonth])`), `PayrollRunLine` (`@@unique([tenantId,
payrollRunId, employeeId])` — the DB-level idempotency backstop),
    `PayslipDocument`, `PayrollBankExport`. Money is `Decimal` everywhere,
    never `Float`. Two migrations (`add_payroll_module`,
    `enable_rls_for_payroll_module`) — the standard "add tables" +
    "enable RLS" pair every prior module's schema step already
    establishes. `packages/db/src/seed-exchange-rates.ts` (new, illustrative
    USD⇄QAR reference rates, wired into `prisma/seed.ts`).
  - **`packages/shared`**: `PERMISSIONS.PAYROLL_APPROVE`/`PAYSLIP_VIEW`;
    `validators/payroll.validator.ts` (`createPayrollComponentSchema` —
    reuses 0.5's `exprSchema` as-is; `runPayrollSchema`);
    `notifications/event-notification-mapping.ts` gains
    `'payroll.payslip_ready'` (the only new event this step needs — "run
    approved" arrives for free via the already-mapped
    `workflow.approved`); `audit/redact.ts`'s `REDACTED_KEY_PATTERN` gains
    `grossPay`/`netPay`/`employerCost`/`componentBreakdown`.
  - **`apps/api/src/payroll`** (new module): `payroll-pack.util.ts`
    (`resolvePayrollPackConfig`, the duplicated-tx-resolver pattern 1.2/1.3
    already establish); `payroll-variables.util.ts` (pure functions —
    years-of-service, period start/end dates, the variable-build contract);
    `components/` (`PayrollComponentDefinitionService`, with a static
    pre-gross-variable-only check over component formulas — no second
    evaluator); `engine/payroll-engine.service.ts` (THE CALCULATE-mode
    engine, proven against both reference packs); `delegate/`
    (`PAYROLL_PROVIDER_ADAPTER` seam + `StubPayrollProviderAdapter`);
    `bank-export/` (`BANK_EXPORT_ADAPTER` seam +
    `GenericCsvBankExportAdapter`); `payslip/` (`PayslipPdfService` via a
    new `pdfkit` dependency + bundled `DejaVuSans(-Bold).ttf` fonts under
    `apps/api/assets/fonts/` for Arabic glyph coverage — no PDF-generation
    skill was actually available in this environment;
    `PayslipService` orchestrates render/store/notify); `runs/`
    (`PayrollRunService` orchestration, `PayrollRunQueueService` producer,
    `PayrollRunProcessor` worker — resumable, two-layer-idempotent, the
    SAME "bootstrap transaction then per-employee short transactions"
    shape `LeaveAccrualProcessor` already establishes;
    `PayrollWorkflowEventsListener`, `ExchangeRateService`,
    `MultiCurrencyRollupService`); `payroll.controller.ts` (every route
    `@RequireFeature(MULTI_COUNTRY_PAYROLL)` + permission-gated; no
    approve/reject route — THE RULE). `app.module.ts`,
    `notification-dispatch.listener.ts`, `domain-event-audit.listener.ts`
    each gained one mechanical, additive line for the new module/event
    namespace.
  - **A real bug caught and fixed during this step**: `POST /payroll/runs/
:id/bank-export` originally carried `@AuditLog`, but the route returns a
    `StreamableFile` wrapping a live Node stream — `AuditInterceptor`
    tried to redact it as the audit row's `after` value and overflowed the
    stack on every call (surfacing as a BullMQ job silently retrying a
    crashing bank-export in one e2e run, and a clean 500 in another). Fixed
    by following `EmployeeDocumentsController.download`'s own existing
    precedent: a `StreamableFile`-returning route never carries
    `AuditInterceptor` — the DB row the service itself writes
    (`PayrollBankExport`) is the durable record instead. See
    docs/conventions/payroll.md for the full account.
  - Verified end-to-end over real HTTP by `apps/api/test/payroll.e2e-spec.ts`
    (8 tests — see docs/conventions/payroll.md's own closing paragraph for
    the full list: US/QA divergence with real hand-computed numbers
    including the gratuity regression proof, DELEGATE-mode routing,
    idempotency, resumability, workflow approval through to finalize/
    bank-export/payslip in both languages, `salary.view`/`payslip.view`
    gating, cross-tenant isolation) plus `payroll-variables.util.spec.ts`
    (5 pure-function unit tests). `apps/api` grows from 258 to 271 tests;
    `packages/db`'s 14 unchanged — 285 backend tests total, zero
    regressions. Full-repo `pnpm build`/`pnpm lint` green across all seven
    workspaces; `apps/portal`/`apps/mobile` untouched by this step (no
    portal work was in this step's scope).

- **2.2 Performance management module — done — 2026-08-31.** A THIN
  CONSUMER of existing systems — full design in
  [`docs/conventions/performance.md`](./conventions/performance.md).
  Routing/sign-off is a real 0.7 `WorkflowInstance` (THE RULE — this module
  owns zero approve/reject logic), reviewers resolve via 1.1's real
  `Employee.managerId`/`directReports` org chart, and reminders ride the
  0.8 notification hub. The genuinely new concepts are `RatingScale` and an
  `AppraisalCycle`'s review-type/eligibility configuration — both modeled
  as tenant-editable DATA (JSON, app-layer validated), never a closed
  code-level enum: "360" is simply a cycle whose `enabledReviewTypes`
  includes all four `ReviewType`s, not a fifth type. Files:
  - **`packages/db`**: seven new tenant-scoped tables —
    `RatingScale` (`levels: Json`, a `RatingLevel[]`), `AppraisalCycle`
    (`enabledReviewTypes`/`eligibleBranchIds`/`eligibleDepartmentIds: Json`,
    empty eligibility arrays = every branch/department), `Goal` (cascading
    COMPANY -> TEAM -> INDIVIDUAL via the same composite-self-relation
    pattern `Branch.parentBranchId`/`Employee.managerId` already
    establish), `Appraisal` (one row per cycle x employee,
    `@@unique([tenantId, cycleId, employeeId])`), `ReviewAssignment` (the
    roster of who owes a review — SELF/MANAGER/UPWARD auto-created at
    enrollment, PEER always explicit), `Review` (the submitted content,
    1:1 with a fulfilled assignment), and
    `AppraisalRatingDistributionSnapshot` (the calibration rollup — same
    delete-then-bulk-`createMany` shape `AnalyticsRollupProcessor`
    established, for the identical nullable-`departmentId` reason). Two
    migrations (`add_performance_module`, `enable_rls_for_performance_module`)
    — the standard pair every prior module's schema step establishes; no
    RLS-exempt table this time (unlike Payroll's `exchange_rates`) — every
    row here is tenant-authored configuration or data, never global
    reference data.
  - **`packages/shared`**: `PERMISSIONS.PERFORMANCE_READ/WRITE/REVIEW/MANAGE`
    (`REVIEW` seeded onto `EMPLOYEE`/`MANAGER`/`HR_MANAGER` — anyone may be
    asked to peer-review a colleague; `MANAGE` is `HR_MANAGER`/
    `TENANT_ADMIN` only — cycle/rating-scale administration);
    `validators/performance.validator.ts` (`ratingLevelSchema`,
    `createRatingScaleSchema`, `createAppraisalCycleSchema`,
    `createGoalSchema`, `updateGoalProgressSchema`,
    `assignPeerReviewersSchema`, `submitReviewSchema`);
    `notifications/event-notification-mapping.ts` gains
    `'performance.cycle_opened'`/`'performance.review_due'` (sign-off
    itself needs no new event — `workflow.submitted`/`workflow.approved`
    already notify for free, THE RULE's payoff yet again).
  - **`apps/api/src/performance`** (new module): `rating-scales/`
    (`RatingScaleService`, upsert-by-`(tenantId, key)`); `goals/`
    (`GoalService`, the "own vs. `performance.manage`" two-layer shape
    Leave already establishes); `reviews/` (`reviewer-resolver.util.ts` —
    resolves SELF/MANAGER/UPWARD via the REAL 1.1 org chart, stopping at
    the Employee rather than continuing on to a User the way a workflow
    approver rule does; `ReviewService` — peer assignment, submission,
    "my pending assignments"); `cycles/appraisal-cycle.service.ts` (cycle
    lifecycle + ENROLLMENT — the one place eligibility config turns into
    real `Appraisal`/`ReviewAssignment` rows, synchronous and cheap, no
    BullMQ queue needed unlike Payroll's per-employee salary computation);
    `appraisals/` (`AppraisalService.submitForApproval` — requires every
    assignment `SUBMITTED`, averages `Review.overallRating` unweighted,
    starts the `WorkflowInstance`; `AppraisalWorkflowEventsListener`
    reacting to `workflow.approved`/`workflow.rejected`, mirroring
    `PayrollWorkflowEventsListener`/`LeaveWorkflowEventsListener` exactly);
    `calibration/` (`calibration-rollup.util.ts` — pure, unit-tested
    grouping function; `CalibrationQueueService`/`CalibrationProcessor` —
    the SAME pre-aggregation discipline `AnalyticsRollupProcessor`
    established, enqueued once per appraisal that reaches `COMPLETED`, plus
    a manual backfill/test lever mirroring `POST /analytics/rollup/run`;
    `CalibrationService` — reads ONLY the snapshot table, never live-
    aggregates `Appraisal`). `performance.controller.ts` — RBAC-gated only,
    no feature-flag gating (unlike Payroll's ENTERPRISE-only flag; this
    module is the same posture as Leave/Attendance/Employee); deliberately
    no approve/reject route — THE RULE. `app.module.ts`,
    `notification-dispatch.listener.ts`, `domain-event-audit.listener.ts`,
    `notification-recipient-resolver.service.ts`, `queue.constants.ts` each
    gained mechanical, additive lines for the new module/event namespace
    (the recipient resolver's two new cases: `performance.review_due`
    reads a direct `reviewerUserId` payload field, same shape
    `workflow.escalated` already uses; `performance.cycle_opened` queries
    enrolled `Appraisal` rows for the cycle, same shape `workflow.submitted`
    already uses).
  - Verified end-to-end over real HTTP by
    `apps/api/test/performance.e2e-spec.ts` (7 tests: two tenant-authored
    rating scales with different level shapes driving two different
    cycles through the same code path, incl. a 404 for an unknown scale
    key; a full cycle run — goals cascading COMPANY/TEAM/INDIVIDUAL with
    progress tracking, the MANAGER review assignment resolving through the
    real 1.1 org chart, reminders landing via the real 0.8 hub as
    assignments are created, self+manager+peer reviews submitted and an
    explicit peer assignment, routing + sign-off through the real 0.7
    workflow to the real manager, the averaged `overallRating` landing
    correctly; calibration/distribution correct, pre-aggregated,
    branch-scoped — an HR user restricted to a branch with no completed
    appraisals sees an empty distribution for the SAME cycle, never a
    403 — and RBAC-gated for a plain employee; cross-tenant isolation via
    RLS) plus `calibration-rollup.util.spec.ts` (5 pure-function tests,
    including the nullable-`departmentId` non-double-counting proof).
    `apps/api` grows from 271 to 283 tests (271 existing + 7 e2e + 5 unit);
    `packages/db`'s 14 unchanged — 297 backend tests total, zero
    regressions. Full-repo `pnpm build`/`pnpm lint` green across all seven
    workspaces; `apps/portal`/`apps/mobile` untouched by this step (no
    portal/mobile work was in this step's scope).

- **2.3 Recruitment (ATS) + Onboarding + Offboarding — done — 2026-08-31.
  PHASE 2 COMPLETE.** The employee LIFECYCLE — full design in
  [`docs/conventions/recruitment-lifecycle.md`](./conventions/recruitment-lifecycle.md).
  A thin consumer of five Phase 0/1/2 systems: the workflow engine (every
  approval), the Employee module (the candidate → Employee conversion),
  country packs (required-field enforcement, via 1.1), the notification
  hub (checklist reminders), and — the two hardest reuse problems this
  step solved — Payroll (a `FINAL_SETTLEMENT` run for a leaver) and Auth
  (access revocation). Files:
  - **`packages/db`**: eleven new tenant-scoped tables —
    `JobRequisition`, `JobPosting` (`publicSlug` unique per tenant — what
    the public careers API resolves by), `Candidate` (deduplicated per
    tenant by email), `Application` (`ApplicationStage` closed enum),
    `Interview`/`InterviewScorecard`, `Offer` (`OfferStatus` has both
    `REJECTED` — internal approval denied — and `DECLINED` — candidate
    turned it down, distinct terminal states), `OnboardingProcess`
    (`employeeId` null until conversion), `OffboardingProcess`,
    `ChecklistTemplate`/`ChecklistTaskInstance` (ONE generic engine shared
    by Onboarding and Offboarding, polymorphic via `processType`/
    `processId`, the `WorkflowInstance.entityType`/`entityId` pattern).
    PLUS the one additive seam on Payroll's EXISTING `PayrollRun` table:
    `runType` (`REGULAR`|`FINAL_SETTLEMENT`) + `settlementEmployeeId`,
    replacing the original blanket `@@unique([tenantId, branchId,
periodYear, periodMonth])` with two hand-written PARTIAL unique
    indexes (Prisma has no partial-index DSL) so the REGULAR-run
    idempotency guarantee stays byte-identical while a NEW,
    equally-strict one-settlement-per-employee-per-period guarantee is
    added alongside it — see recruitment-lifecycle.md's own write-up of
    why a naive shared `@@unique` would have silently weakened the
    original constraint (Postgres NULL-distinctness). Also added
    `OfferStatus.REJECTED` (one small follow-up migration, before any
    code consumed the enum). Four migrations total
    (`add_recruitment_lifecycle_module`,
    `enable_rls_for_recruitment_lifecycle_module`,
    `add_offer_rejected_status`, plus the settlement seam folded into the
    first) — RLS enabled on every new table, no RLS-exempt table this step
    (unlike Payroll's `exchange_rates` — everything here is tenant-owned).
  - **`packages/shared`**: `PERMISSIONS.RECRUITMENT_READ/WRITE/MANAGE`,
    `ONBOARDING_MANAGE`, `OFFBOARDING_MANAGE`; five new validator files
    (`recruitment.validator.ts`, `checklist.validator.ts` —
    `ChecklistAssigneeRule` deliberately mirrors 0.7's `ApproverRule`
    SHAPE without reusing its type/engine, `onboarding.validator.ts` —
    `completeOnboardingSchema` built by `.omit()`ing from the REAL
    `createEmployeeSchema` rather than redefined by hand, so it can never
    drift from what `POST /employees` itself accepts,
    `offboarding.validator.ts`); `event-notification-mapping.ts` gains
    ONE new event, `checklist.task_assigned` (sign-off notifications
    arrive for free via the already-mapped `workflow.submitted`/
    `.approved` — THE RULE's payoff for the fourth module in a row);
    `redact.ts`'s `REDACTED_KEY_PATTERN` gains `proposedSalary`.
  - **`apps/api/src/recruitment`** (new module): `requisitions/`
    (`JobRequisitionService` + its workflow-events listener),
    `postings/` (`JobPostingService` — a posting requires an `APPROVED`
    requisition), `candidates/` (`CandidateService`, upsert-by-email),
    `applications/` (`ApplicationService` — stage transitions, no bespoke
    history table, 0.9's audit log already gives one), `interviews/`
    (`InterviewService` — scheduling + row-level-gated scorecards),
    `offers/` (`OfferService` + its workflow-events listener; `accept`
    emits `recruitment.offer_accepted`), `careers/` (`CareersService` +
    `CareersController`, `@AllowAnonymous()` throughout — the SAME
    "public but tenant-required" pattern `POST /auth/login` already
    establishes, NOT `@Public()`), `recruitment.controller.ts` (the
    internal surface — deliberately no approve/reject route anywhere,
    THE RULE).
  - **`apps/api/src/checklists`** (new, shared module): `checklist.service.ts`
    (instantiate/complete/list, generic over `processType`/`processId`),
    `checklist-template.service.ts` (CRUD), `checklist-assignee-resolver.util.ts`
    (`SPECIFIC_USER`/`ROLE`/`MANAGER` — `MANAGER` resolves through the
    REAL 1.1 org chart, the same data `ApproverResolverService`/
    Performance's `resolveAutoReviewers` already resolve through). No
    controller of its own — Onboarding and Offboarding each expose their
    OWN checklist routes with their own fixed `processType` and
    permission gate.
  - **`apps/api/src/onboarding`** (new module): `onboarding.service.ts`
    (`start` — idempotent against a redelivered event; `createEmployee` —
    the ONE call to the REAL, UNMODIFIED `EmployeeService.create`,
    followed immediately by checklist instantiation against the
    brand-new employee, since a `MANAGER`-rule task has nothing to
    resolve against before the Employee exists), `onboarding-offer-accepted.listener.ts`
    (`@OnEvent('recruitment.offer_accepted')` — no direct
    Recruitment → Onboarding service dependency at all).
  - **`apps/api/src/offboarding`** (new module): `offboarding.service.ts`
    (`initiate` — `requesterId` = the departing employee's OWN linked
    `User.id`, the same reuse Leave/Performance already establish so a
    `MANAGER` approver rule resolves correctly; `complete` — gated on
    every clearance checklist task being `COMPLETED`, then: the REAL
    `EmployeeService.update` status transition, a REAL Payroll
    `FINAL_SETTLEMENT` run via the additive seam above, and REAL access
    revocation via `TokenService.revokeAllForUser` (newly exported from
    `AuthModule`, one additive line) + `User.status = DISABLED`),
    `offboarding-workflow-events.listener.ts` (instantiates the clearance
    checklist on `workflow.approved`).
  - **The two files Payroll's ORCHESTRATION layer gained** (its ENGINE —
    `PayrollEngineService`, the rules engine — is 100% untouched):
    `payroll-run.service.ts`'s `createRun` gained one optional
    `settlement?: { employeeId }` parameter; `payroll-run.processor.ts`'s
    employee-selection query branches on `run.runType` (one `id =
settlementEmployeeId` lookup instead of the branch-wide `ACTIVE`
    query for a `FINAL_SETTLEMENT` run). `auth.module.ts` gained one
    additive `exports: [TokenService]` line. `app.module.ts`,
    `notification-dispatch.listener.ts`, `domain-event-audit.listener.ts`,
    `notification-recipient-resolver.service.ts` each gained mechanical,
    additive lines for the new modules/event namespaces
    (`recruitment.*`/`checklist.*`).
  - Verified end-to-end over real HTTP by
    `apps/api/test/recruitment-lifecycle.e2e-spec.ts` (14 tests: a job
    requisition approved through the real workflow; a posting created
    from it and published; the PUBLIC careers API listing/serving it and
    accepting an application with a resume upload with NO auth, rejecting
    a duplicate apply; candidate pipeline stage transitions captured in
    the 0.9 audit trail; a real interview + scorecard; an offer created,
    approved through the real workflow, and accepted; offer acceptance
    starting a real onboarding process via the fire-and-forget event;
    creating the Employee correctly rejecting a US-branch submission
    missing SSN/W4 and succeeding once supplied; the onboarding checklist
    instantiated from tenant-configurable data with real 0.8 notifications
    landing and a `requiresDocument` task enforcing an attachment; a
    termination routed through the real workflow to the real manager; the
    clearance checklist gating completion; completing offboarding setting
    status/terminatedAt, revoking access (DB flag AND a live previously-
    valid token now rejected), and triggering a real Payroll
    `FINAL_SETTLEMENT` run with Qatar's gratuity accrual correctly
    period-scoped, explicitly bounded below the cumulative-total figure
    the engine's own documented bug guard exists for; cross-tenant
    isolation via RLS, including the public careers route). `apps/api`
    grows from 283 to 297 tests (283 existing + 14 new e2e); `packages/db`'s
    14 unchanged — 311 backend tests total, zero regressions. Full-repo
    `pnpm build`/`pnpm lint` green across all seven workspaces;
    `apps/portal`/`apps/mobile` untouched by this step (no portal/mobile
    work was in this step's scope).

**PHASE 2 COMPLETE.** Payroll (2.1) + Performance (2.2) + Recruitment/
Onboarding/Offboarding (2.3) — the full compensation and employee-lifecycle
layer, all built on Phase 0's chassis and Phase 1's Core HR/Leave/
Attendance/ESS/Analytics foundation with zero modifications to any of it
beyond small, additive, precedented seam columns/exports. Phase 3's scope
is not yet defined (see CLAUDE.md § 6) — candidates for what it might cover
include Recruitment/Performance/Payroll UI on `apps/portal` (all three
landed API-only this phase, the same "backend first, UI later" sequencing
1.1-1.3 took before 1.4 caught the portal up), the transactional-outbox
upgrade flagged in notifications-queues.md, and/or the Phase 5.2 partition
migrations flagged since 0.2.

- **2.4 — Admin/HR Console (Payroll · Performance · Recruitment/Onboarding/
  Offboarding UI), Phase 3's first slice.** The "UI catches up" pass 2.3's
  own closing note named as a Phase 3 candidate: `apps/portal` now surfaces
  all three Phase 2 modules as a functional, demoable admin console — a
  pure consumption layer over already-shipped, already-tested APIs, built
  on 1.4's exact conventions (auth/session, i18n/RTL, RBAC-gated
  rendering, field-omission, `useAsync`, the `components/ui/*` design
  system). Full detail, every file touched, and every bug/race caught
  along the way is in
  [`docs/conventions/frontend-admin-console.md`](./conventions/frontend-admin-console.md)
  — summary:
  - **One additive backend endpoint**: `GET /payroll/runs` (list, with
    `branchId`/`periodYear`/`periodMonth` filters) —
    `apps/api/src/payroll/runs/payroll-run.service.ts`'s new `findMany` +
    `apps/api/src/payroll/payroll.controller.ts`'s new `@Get('runs')`
    route, gated and field-omission-checked identically to the existing
    by-id route. Zero other backend changes anywhere — the payroll engine,
    workflow engine, and every other Phase 2 module's business logic are
    completely untouched.
  - **`apps/portal/src/lib/api/{payroll,performance,recruitment,onboarding,offboarding}.ts`**
    (new) + `lib/api/types.ts` additions, mirroring `leave.ts`/
    `attendance.ts`'s exact function-per-endpoint shape; `lib/api/client.ts`
    gained `apiFetchBlob` (binary downloads — payslip PDF, bank-export
    CSV) and `apps/portal/src/lib/download.ts`'s `triggerBrowserDownload`.
  - **`apps/portal/src/components/workflow/{WorkflowStatusPanel,WorkflowActionForm}.tsx`**
    (new) — one shared inline sign-off panel used by Payroll/Performance/
    Recruitment(requisitions+offers)/Offboarding, with `WorkflowActionForm`
    extracted (behavior-preserving) out of the existing `ApprovalCard.tsx`
    so both share one approve/reject/comment implementation instead of a
    fifth copy. The pre-existing `/approvals` inbox needed ZERO code
    changes to start surfacing all five new `WorkflowInstance.entityType`s
    — only five new `approvals.entity.*` i18n keys.
  - **New pages**: `app/(app)/payroll/{page,[id]/page}.tsx`,
    `app/(app)/performance/{page,[id]/page,appraisals/[id]/page,my-reviews/page}.tsx`,
    `app/(app)/recruitment/{page,candidates/page,candidates/[id]/page,offers/page,onboarding/page,offboarding/page}.tsx`
    - matching `components/{payroll,performance,recruitment,onboarding,offboarding,checklists}/*`
      form/list components, all following `leave/page.tsx`'s established
      page shape. `components/layout/Sidebar.tsx` gained a third
      permission-gated nav section (`adminItems`); `components/ui/Badge.tsx`
      gained additive `STATUS_TONE` entries for the new status vocabularies.
  - **Known, documented gaps carried forward, not silently dropped**: no
    department/designation pickers anywhere (no listing endpoint exists,
    and every consuming field is optional); no download route for a
    candidate's resume or a checklist task's uploaded document (only the
    storage key is exposed, inherited from 2.3); `AppraisalDetail.employee`
    is a raw, unredacted embed on the frontend type — deliberately narrowed
    to identity-only fields.
  - **Real bugs/races found and fixed while writing this step's own
    tests** (all detailed in the conventions doc): `apiFetchBlob` was
    initially hardcoded to `GET` (bank-export needs `POST`); a checklist-
    completion race where completing one `MyTasksList` task's `reload()`
    briefly unmounts/remounts every row including a second task's file
    input (fixed in the TEST, by waiting for the first row to disappear
    before touching the second); stacking multiple full-page `page.goto()`
    reloads within one login session can race 0.4's refresh-token rotation
    and trip its reuse-detection guard (fixed by one-login-per-test,
    mirroring 2.2's own test-writing precedent); the fixture tenant's
    `STARTER`-tier per-tenant request-volume quota (0.10) is a REAL
    resilience control this suite's own volume legitimately exceeds — fixed
    by seeding both fixture tenants as `edition: 'ENTERPRISE'` in
    `global-setup.ts`, a separate mechanism from the `multi_country_payroll`
    feature-flag override Payroll already needed.
  - Verified: full-repo `pnpm build`/`pnpm lint` green across all eight
    package tasks; `apps/api`'s full suite green at 301 tests (297 existing
    - 4 new for `GET /payroll/runs`); `apps/portal`'s full Playwright suite
      green at 51 tests (17 existing + 34 new across `payroll.spec.ts` (10),
      `performance.spec.ts` (10), `recruitment.spec.ts` (14)), including
      every pre-existing spec with zero regressions.

- **3.1 — Operations modules (Expenses & Reimbursements · Asset Management ·
  HR Helpdesk/Ticketing · Announcements & Policies), Phase 3's first
  slice.** Four thin modules, backend + portal UI together, each a pure
  consumer of systems that already existed — the workflow engine (0.7),
  storage (1.1), notifications (0.8), audit (0.9), RBAC (0.4) — none of
  which needed to change. Full detail, every design decision, and every
  bug caught along the way is in
  [`docs/conventions/operations-modules.md`](./conventions/operations-modules.md)
  — summary:
  - **Docs housekeeping first**: the prior admin-console UI step, originally
    logged as "3.1" (a numbering collision with THIS step, the plan's real
    3.1), was renumbered to **2.4** throughout `CLAUDE.md`/this file/its own
    convention doc — it belongs to Phase 2's own closing note, not Phase 3.
  - **Expenses & Reimbursements**: `ExpenseCategory` (tenant policy-limit
    config)/`ExpenseClaim`/`ExpenseLine` (`packages/db`), approved via the
    REAL 0.7 workflow (`entityType: "EXPENSE_CLAIM"` — literally the SAME
    string `workflow.e2e-spec.ts`'s own reference conditional-amount
    fixture has used since 0.7). Policy limits enforced at `submit`, not
    line-add time. Multi-currency reuses Payroll's OWN `ExchangeRateService`
    (a new additive export off `PayrollModule`) for the SAME Decimal
    approach — a claim's `totalAmountBaseCurrency` is snapshotted once at
    submission. **The reimbursement hand-off**: `PayrollRunProcessor`
    (already touched by 2.3 for `FINAL_SETTLEMENT`) gained one additive
    step, `mergeReimbursements` — sums an employee's `APPROVED`,
    not-yet-consumed claims and adds the total straight onto `netPay`/
    `employerCost` after the ENGINE call returns, completely untouched;
    consumed claims flip to `REIMBURSED`. Receipts via 1.1's
    `StorageService`/MinIO.
  - **Asset Management**: `AssetCategory`/`Asset` (a denormalized `status`
    cache)/`AssetAssignment` (append-only per assign/return cycle, a real
    history)/`AssetMaintenanceRecord`. **The offboarding clearance
    checklist's real "asset return" step** — a placeholder 2.3 explicitly
    flagged as a Phase 3 candidate: `OffboardingService` gained one new
    method, `completeTask`, which blocks completing a task whose `key` is
    exactly `ASSET_RETURN_CHECKLIST_TASK_KEY` (`'asset_return'` — the SAME
    string `recruitment-lifecycle.e2e-spec.ts`'s own 2.3 fixture already
    used) while any asset remains assigned to that employee — the generic
    `ChecklistService` itself is completely unchanged; the wiring lives
    entirely in the consuming module.
  - **HR Helpdesk / Ticketing**: `TicketCategory` (tenant SLA-minutes
    config)/`Ticket`/`TicketComment`/`TicketAttachment`. SLA resolved once
    at ticket creation into `Ticket.slaDueAt`, never re-derived.
    `TicketSlaService.sweepOverdueTickets()` mirrors
    `WorkflowEscalationService.sweepOverdueSteps` (0.7) exactly — cross-
    tenant discovery via the owner `prisma` client, per-tenant mutation
    inside `withTenantContext`; not wired to a scheduler, same as 0.7's own
    sweep. One new mapped notification event, `helpdesk.ticket_escalated`
    (assignee if set, else every `HR_MANAGER` — the SAME fallback
    `licensing.issued`/`.revoked` already establish).
  - **Announcements & Policies**: `Announcement` (branch/department
    targeting, empty array = unrestricted)/`Policy` (versioned, republish
    is a new row, never an in-place edit)/`PolicyAcknowledgment`. Wires the
    ESS "announcements seam" 1.4 deliberately left as a placeholder (both
    the dedicated `/announcements` page AND the dashboard's own "coming
    soon" widget) to real, tenant-authored data. `apps/mobile`'s own
    equivalent placeholder is deliberately untouched — out of this step's
    scope, same boundary 2.3 held itself to.
  - **A real, general bug caught and fixed**: `@hrm/shared`'s
    `redactSensitiveFields` (the ONE audit-redaction function every
    `AuditInterceptor`/`DomainEventAuditListener` write goes through)
    walked a live `Prisma.Decimal`/`Date` instance's own properties
    structurally instead of using its `toJSON()` — for `Decimal` this
    wasn't even valid `Json` input (a 500 on the first audited
    Decimal-bearing route this codebase ever shipped), and for `Date` it
    silently mangled every timestamp in every audited payload across the
    ENTIRE codebase into `{}`, a pre-existing defect nothing had tripped
    loudly before. Fixed once, in `packages/shared`, retroactively
    correcting every OTHER module's audited routes too (Payroll's runs/
    lines included) — not just this step's own new ones.
  - **RBAC**: eight new permissions (`expense.{read,write,manage}`,
    `asset.{read,manage}`, `helpdesk.{read,write,manage}`,
    `announcement.{read,manage}`, `policy.{read,manage}`) — the
    self-service half (`*.read`/`*.write`) seeded onto every system role
    including `EMPLOYEE`, the `*.manage` half onto `TENANT_ADMIN`/
    `HR_MANAGER` only.
  - **Portal**: `apps/portal/src/lib/api/{expenses,assets,helpdesk,
announcements}.ts` (the identical one-function-per-route shape every
    prior `lib/api/*.ts` file already establishes) + matching
    `components/{expenses,assets,helpdesk,announcements}/*` and
    `app/(app)/{expenses,assets,helpdesk,announcements}/{,admin}/page.tsx`
    — eight new pages (an ESS + an admin page per module), built on 2.4's
    exact conventions: `useAsync`, the `components/ui/*` design system, an
    expandable `<details>` row (not a separate detail route) for inline
    line-items/comments/maintenance-history/`WorkflowStatusPanel` —
    "functional over fancy," the SAME pattern 2.4's Recruitment pages
    already established for requisition/offer rows. `ApprovalCard`'s
    `SnapshotSummary` gained one new `EXPENSE_CLAIM` case (amount +
    currency) — the pre-existing `/approvals` inbox needed no other
    changes to start surfacing expense-claim approvals, THE RULE's payoff
    restated once more. `Sidebar`/`Badge`'s `STATUS_TONE` gained additive
    entries only.
  - **Two real bugs/races caught while writing this step's own Playwright
    tests** (both detailed in the conventions doc): the `redactRecursive`
    bug above, first surfaced as a live 500 while testing expense category
    creation; and a test doing TWO `login()` calls within ONE `test()`
    (switching users mid-test) redirecting `/login` back to `/dashboard`
    mid-fill since the earlier session was still valid — the exact "one
    login per test" lesson `frontend-admin-console.md` already documents
    for a related flakiness class, re-confirmed here and fixed the same
    way: split each multi-actor flow into separate sequential tests within
    one `describe.serial` block.
  - Verified: `apps/api/test/operations-modules.e2e-spec.ts` (17 tests) +
    `apps/portal/tests/operations-modules.spec.ts` (17 Playwright tests).
    `apps/api`'s full suite green at 318 tests (301 existing + 17 new);
    `apps/portal`'s full Playwright suite green at 68 tests (51 existing +
    17 new), including every pre-existing spec with zero regressions.
    Full-repo `pnpm build`/`pnpm lint` green across all eight package
    tasks.

- **3.2 — Learning & Development (LMS), Phase 3's second slice.** A thin
  module, backend + portal UI together, the same posture 3.1's four
  operations modules already established — content lives in 1.1's
  StorageService/MinIO, expiry reminders reuse 0.8's notification hub, and
  BOTH schedulable jobs (rollup + certification expiry) reuse 1.5's
  scheduled-BullMQ-job pattern verbatim. Full detail is in
  [`docs/conventions/lms.md`](./conventions/lms.md) — summary:
  - **Schema** (`packages/db`, 12 new tables): `CourseCategory`/`Course`/
    `CourseContentItem` (catalog + ordered content, `moduleName`/
    `orderIndex` — no separate Module table, a deliberate "flat list, not
    over-engineered" call); `Enrollment`/`ContentProgress` (SELF vs.
    ASSIGNED, deliberately NO unique constraint on `(course, employee)` —
    see the renewal note below); `Quiz`/`QuizQuestion`/`QuizAttempt`
    (config-as-data scoring, single-correct-answer multiple choice,
    `correctOptionKey` never served to a learner taking the quiz);
    `Certification` (issued on completion, `expiresAt` from `Course.
validityMonths`, a self-relation `renewedFromCertificationId` — a second
    completion of the SAME course while an ACTIVE cert already exists
    supersedes it, RENEWED); `RequiredTraining` (independently-nullable
    `roleId`/`branchId`, "absence means unrestricted"); two rollup tables
    (`CourseCompletionDailySnapshot`/`TrainingComplianceDailySnapshot`,
    the SAME small-dimension point-in-time-cross-section discipline 1.5
    established).
  - **Completion gating**: one function,
    `EnrollmentService.recomputeCompletion`, decides completion — every
    content item COMPLETED AND (no required quiz OR a passing
    `QuizAttempt`) — called after every content-progress mark and every
    quiz submission, so completion is never computed two different ways.
  - **Two independent scheduled BullMQ jobs**, both the identical
    orchestrate-then-fan-out-per-tenant shape `AnalyticsRollupService`
    established: `LmsRollupService` (daily completion/compliance rollup)
    and `CertificationExpiryService` (daily expiry-reminder sweep,
    idempotent via a `lastReminderBucket` column compared each run — no
    Redis `IdempotencyService` needed, DB-native idempotency instead).
  - **Compliance analytics — the two-tier split**: the dashboard KPI
    numbers read ONLY the rollup tables (never live-aggregate `Enrollment`/
    `Certification` at scale); a bounded, branch-filtered "who exactly is
    missing/expiring" drill-down (`LmsComplianceService.listGaps`) is a
    normal live indexed read, the same split `GET /payroll/runs` already
    establishes for its own operational list.
  - **RBAC**: five new permissions (`lms.read`/`.enroll`/`.author`/
    `.assign`/`.manage`) — `read`+`enroll` on every role including
    `EMPLOYEE`; `MANAGER` additionally holds `assign`; `HR_MANAGER` holds
    all five (`TENANT_ADMIN` via `ALL_PERMISSIONS`).
  - **Portal**: `/learning` + `/learning/[id]` (ESS: catalog, enroll,
    content, quiz-taking, certifications, due dates) and `/learning/admin`
    - `/learning/admin/compliance` (authoring, assignment, required-
      training rules, compliance dashboard + gaps). No department/role
      picker on required-training rules — this codebase has no `GET /roles`
      listing endpoint anywhere (0.4's own documented gap), the same
      "documented, not silently accepted" posture 2.4 already takes for its
      own missing department pickers.
  - **A real UI race caught and fixed while writing the Playwright spec**:
    a passing quiz attempt flips the enrollment to COMPLETED as a side
    effect of the SAME reload that revealed the pass/fail result, which
    was unmounting the quiz card (and the "Passed" message on it) before
    a learner — or the test — could ever see it. Fixed with a local
    `quizJustCompleted` flag that keeps the card mounted for the rest of
    that page view once a passing attempt lands.
  - Verified: `apps/api/test/lms.e2e-spec.ts` (15 tests: authoring +
    catalog visibility + RBAC; enroll -> content progress -> a required
    quiz genuinely gating completion (a failing attempt keeps it open) ->
    a passing attempt completing it and issuing a certification with the
    right validity window; admin assignment + a real notification +
    duplicate-assignment rejection; the live gaps drill-down AND the real
    scheduled rollup job populating the compliance dashboard; the
    certification-expiry sweep's idempotency (no duplicate reminder on a
    second run) and its EXPIRING -> EXPIRED transition; cross-tenant
    isolation) plus `lms-rollup.util.spec.ts` (10 pure-function tests) and
    `apps/portal/tests/lms.spec.ts` (8 Playwright tests over the real
    browser/API/Postgres/Redis/MinIO stack). `apps/api`'s full suite green
    at 344 tests (318 existing + 15 e2e + 10 rollup-util + a spec.ts
    reshuffle already counted); `apps/portal`'s full Playwright suite
    green at 76 tests (68 existing + 8 new), zero regressions. Full-repo
    `pnpm build`/`pnpm lint` green across all workspace tasks.

- **3.3 — Integrations, Phase 3's final slice and PHASE 3 COMPLETE.** The
  "extend without forking" escape hatch: outbound webhooks, a versioned
  API-key-authenticated public API, four adapter seams, and SSO finished.
  Full detail is in [`docs/conventions/integrations.md`](./conventions/integrations.md)
  — summary:
  - **Outbound webhooks** — `WEBHOOK_EVENT_TYPES` (`packages/shared`) is
    pure data mirroring the events already emitted; `WebhookDispatchListener`
    subscribes to the SAME wildcard namespaces `NotificationDispatchListener`
    already does. `WebhookSubscription` → `WebhookDelivery` (0.8's
    `Notification`/`NotificationDelivery` shape, reused). HMAC-SHA256
    signing (`t=...,v1=...`, Stripe/GitHub's own convention) with a secret
    generated once and AES-256-GCM-encrypted at rest. Delivery is
    breaker-wrapped ONE PER SUBSCRIPTION (`CircuitBreakerService`) and
    retried/dead-lettered via the SAME shape `NotificationDeliveryService`
    established. `webhook.manage`-gated (TENANT_ADMIN only), a NEW
    `FEATURE_FLAGS.WEBHOOKS` (PROFESSIONAL+), `@AuditLog`'d.
  - **Versioned public API (`/v1`) + API keys** — `TenantScopeInterceptor`
    gained ONE new branch: an `X-Api-Key` header authenticates AND resolves
    the tenant in one step (skipping host-based resolution entirely),
    still opening the SAME `withTenantContext` transaction RLS is enforced
    through. `ApiKey.scopes` reuse RBAC's own `PERMISSIONS` catalog
    directly — `PermissionsGuard` needed zero changes. Keys are
    argon2id-hashed (`HashingService`, generalized out of
    `PasswordService`'s algorithm) — one-way, shown once at creation.
    Per-key rate limiting (`ApiKeyRateLimitService`) runs alongside the
    existing per-tenant limiter. `V1Module` is a deliberate, curated slice
    (employees, leave) reusing the EXISTING services directly — not a
    mirror of the whole internal API. `@nestjs/swagger` serves OpenAPI for
    `/v1` only at `GET /v1/docs`.
  - **Adapter seams** — Accounting (QuickBooks/Xero-shaped,
    `NoopAccountingAdapter` stub), Slack (a REAL `NotificationProvider`
    reusing the 0.8 provider seam exactly — one additive `SLACK`
    `NotificationChannel` enum value, opt-in via the existing
    `NotificationPreference` mechanism), biometric devices (formalizes the
    UNCHANGED 1.3 `BiometricDeviceAdapter` with a real per-tenant device
    registry + secret-authenticated ingestion endpoint), bank export
    (formalizes payroll.md's single-CSV-format gap into a genuinely
    pluggable `BankExportAdapterRegistry`, additive on top of the existing
    binding — every pre-3.3 run behaves identically).
  - **SSO finished** — a SEPARATE flow/DI-token pair
    (`SsoAuthProvider`/`OIDC_AUTH_PROVIDER`/`SAML_AUTH_PROVIDER`), not a
    second `AUTH_PROVIDER` binding; `AUTH_PROVIDER`/`LocalAuthProvider`
    (0.4) are completely unchanged. `OidcAuthProvider` is the ONE real,
    cryptographically-verified provider (Authorization Code flow, RS256
    id_token verification against the IdP's JWKS using only Node's
    built-in `crypto` + `jsonwebtoken`). `SamlAuthProvider` builds a real
    AuthnRequest redirect but its response verification is a documented,
    loud `NotImplementedException` — a real XML-DSig verifier is
    deliberately not hand-rolled. Find-or-provision a real `User` on first
    login; issues the SAME tokens `AuthService.login` does.
    `FEATURE_FLAGS.SSO` (ENTERPRISE-only, unchanged since 0.6) gates every
    mutation AND `/login`/`.../callback` themselves.
  - **A real bug caught during this step**: the first attempt at the
    circuit-breaker/dead-letter e2e test wrote
    `expect(deliveryService.deliver(...)).rejects.toThrow()` for a
    single-attempt (`maxAttempts: 1`) delivery — but `deliver` treats a
    final attempt as a NORMAL RESOLUTION (it records `DEAD_LETTER` and
    returns, it doesn't re-throw), so `.rejects` on a promise that actually
    resolves hung the whole test run rather than failing fast. Fixed by
    asserting the resulting row's status directly instead of the promise's
    rejection — the same lesson `payroll.md`'s own idempotency section
    already recorded once for a structurally similar mistake ("a FAILED
    attempt caught INSIDE the wrapped function is treated as a completed
    success").
  - Verified: four new `apps/api/test/*.e2e-spec.ts` files (34 tests) +
    `bank-export-adapter.registry.spec.ts` (2 unit tests) — see
    `docs/conventions/integrations.md`'s own closing paragraph for the
    full breakdown. `apps/api`'s full suite green at 380 tests (344
    existing + 36 new), including one pre-existing assertion
    (`licensing-saas.e2e-spec.ts`) updated to expect the new `webhooks`
    flag in `PROFESSIONAL`'s list. `apps/portal`'s 76-test Playwright suite
    and `apps/mobile`'s 19-test Jest suite both verified green, untouched
    by this step (no `apps/portal` UI in this step's scope). Full-repo
    `pnpm build`/`pnpm lint` green across all eight workspace tasks.

**PHASE 3 COMPLETE** — LMS (3.2) + Operations modules (3.1) + Integrations
(3.3), on top of every prior phase's foundation. Phase 4 is not yet broken
into individual steps — see CLAUDE.md § 6 for its named scope (vendor
console, billing, white-label).

- **4.1 — Vendor super-admin console, Phase 4's first slice.** The
  platform YOU (the vendor) operate to run the whole business —
  cross-tenant by nature, the single most dangerous surface in the
  system, locked down accordingly. Full detail in
  [`docs/conventions/vendor-console.md`](./conventions/vendor-console.md)
  — summary:
  - **Closed a real gap**: through 0.6/0.10, `@PlatformRoute()` carried NO
    authenticated identity — only the `PLATFORM_MODE_ENABLED` flag. Any
    caller who could reach the API could issue/revoke a license or
    override a tenant's rate limit once that flag was on. Every platform
    route now requires a fully authenticated, MFA-verified `PlatformAdmin`
    by default, via `TenantScopeInterceptor`'s new platform branch +
    `PlatformAuthContextService` — the ONLY exemption is
    `@AllowAnonymousPlatform()` on the handful of routes that themselves
    establish a session (login/enroll/verify/refresh).
  - **Platform identity** — `PlatformAdmin` (`schema.prisma`), NOT
    tenant-scoped/NOT RLS-subject like `Tenant`/`CountryPack`, structurally
    separate from tenant `User` (no FK, no shared table). Two code-level
    least-privilege roles (`PlatformRoleName`: `PLATFORM_OWNER` |
    `PLATFORM_SUPPORT`) checked against `@hrm/shared`'s
    `PLATFORM_ROLE_PERMISSIONS` (a pure code constant, the same posture
    `EDITION_FEATURES` documents for itself) via a NEW
    `PlatformPermissionsGuard` + `@RequirePlatformPermissions()` — the
    platform-context sibling of 0.4's `PermissionsGuard`. `TENANT_DELETE`
    and `ADMIN_MANAGE` are deliberately separate, PLATFORM_OWNER-only
    permissions, held back from `PLATFORM_SUPPORT` even though it can read
    everything and start impersonation sessions.
  - **Mandatory MFA** — `PlatformAuthService`'s full state machine:
    password verify → (`mfaSetupRequired` → `POST .../mfa/enroll` →
    `POST .../mfa/enroll/confirm`, persisting `mfaSecretEncrypted`
    (AES-256-GCM via the EXISTING `EncryptionService`) + hashed one-time
    recovery codes (`HashingService`) only on success) OR
    (`mfaRequired` → `POST .../mfa/verify`, TOTP or a single-use recovery
    code) → a real session either way. TOTP is RFC 4226/6238 implemented
    with ONLY Node's built-in `crypto`
    (`apps/api/src/platform/auth/totp.util.ts`) — no new dependency.
    Re-checked (`mfaEnabled`) on every subsequent request, not just at
    login. Independently rate-limited at both factors.
  - **Platform tokens** — `PlatformTokenService`, a SEPARATE `PLATFORM_JWT_SECRET`
    and `JwtService` instance from tenant auth's `TokenService` — a
    tenant token can never verify as a platform token or vice versa, a
    structural guarantee, not a convention. Refresh rotation + reuse
    detection mirrors 0.4's `TokenService` exactly, keyed by
    `platformAdminId` alone (deliberately a separate small implementation,
    not a generalized shared base). `PlatformAuthContextModule` is a leaf
    module (mirrors 3.3's `ApiKeyAuthModule`) imported by `TenancyModule`.
  - **Tenant lifecycle** (`platform/tenants/`) — create (seeds real RBAC
    via 0.4's `seedSystemRolesAndPermissions`, optionally an initial
    `TENANT_ADMIN` user) / suspend / resume / update (edition, hosting
    region, a new `Tenant.provisionMode` SEAM column — `SHARED_DB` |
    `DB_PER_TENANT`, documented-only per this step's own brief) / a
    genuinely irreversible delete (confirm-by-exact-slug, cascades
    everything). **`TENANT_STATUS` is now actually enforced** — flagged
    as deliberately unchecked since 0.3/0.6 —
    `TenantScopeInterceptor` now rejects (403) EVERY request for a
    `SUSPENDED`/`CANCELLED` tenant, including the LOGIN route itself,
    before rate limiting or the DB transaction opens, on both the JWT and
    API-key paths.
  - **Country Pack authoring/versioning** (`platform/country-packs/`) —
    CRUD/lifecycle around the EXISTING 0.5
    `countryPackConfigSchema`/`CountryPackResolutionService`, unmodified.
    Create auto-activates v1; every later version is a DRAFT (cloned from
    the active config by default) until explicitly activated; editing an
    ACTIVE version in place is rejected (400) — draft-then-activate is the
    only path. "Well-formed before activation" is checked TWICE: the
    route's `ZodValidationPipe` on every write, AND the service re-`safeParse`s
    the stored config again at activation time (proven by writing a
    malformed row directly, bypassing the API, and confirming activation
    still refuses it).
  - **Usage metrics** (`platform/usage/`) — seats
    (`Employee.count` vs. the active License/Subscription seat cap, an
    indexed COUNT), storage (`EmployeeDocument.aggregate`, the only place
    a file size is tracked today — an honest, documented gap elsewhere),
    API volume (the LIVE Redis counter `TenantRateLimitService` already
    increments — a new `getCurrentWindowUsage` method, additive — a
    snapshot, not a historical rollup, another honest gap), and a
    platform-wide overview (`Tenant.groupBy` on indexed columns). Never a
    live heavy-table scan, per this step's own brief.
  - **Impersonation** (`platform/impersonation/`) — designed to the
    brief's own four requirements: (a) permission-gated
    (`IMPERSONATION_START`, refuses a suspended tenant or non-ACTIVE
    target user), (b) time-boxed (a server-side `MAX_IMPERSONATION_MINUTES = 60`
    hard cap regardless of what's requested; the minted token
    (`TokenService.signImpersonationAccessToken`, an ADDITIVE method on
    the EXISTING 0.4 `TokenService`) carries `impersonatedBy`/
    `impersonationSessionId` claims, and — critically — the LIVE
    `ImpersonationSession` DB row is what `TenantScopeInterceptor.authenticate()`
    actually re-checks on every single request, not just the token's own
    `exp`; no refresh token is issued alongside it, so a lapsed session
    requires a new, separately-audited one rather than a silent
    extension), (c) LOUDLY audited (session start/end recorded into BOTH
    the new `PlatformAuditRecordService` AND — via the EXISTING
    `AuditRecordService.recordForTenant`, `actorPlatform: true` — the
    TARGET TENANT'S OWN `audit_log`; every action taken WHILE
    impersonating is tagged too, via a new `impersonatedByPlatformAdminId`
    field on `RequestTenantStore` that `AuditInterceptor` now includes in
    every captured mutation's metadata), (d) never silent (a tenant's own
    `TENANT_ADMIN` sees it themselves via their ordinary `GET /audit` —
    not merely told it's logged somewhere they can't see). Ending your
    OWN session vs. REVOKING another admin's are different, differently-
    gated operations (`IMPERSONATION_START` self-only vs.
    `ADMIN_MANAGE`-gated `/revoke`).
  - **Cross-tenant audit read** (`platform/audit/`) — the platform's own
    `PlatformAuditLog` (NOT tenant-scoped/NOT RLS-subject, same exemption
    class as `PlatformAdmin`; partition-ready composite PK like
    `AuditLog`) for actions with no single tenant to attach to (pack
    authoring, cross-tenant listings, platform-admin management), plus a
    read of any SPECIFIC tenant's own `audit_log` cross-tenant via the
    owner `prisma` client. Every read through EITHER path is itself
    logged into `PlatformAuditLog` — reading the trail is an audited
    action too.
  - **`apps/admin`** built out from its prior near-empty placeholder — its
    OWN distinct visual identity (indigo/slate Tailwind tokens vs.
    `apps/portal`'s teal/sand, deliberately, so the two apps are never
    visually confusable), reusing `apps/portal`'s `components/ui/*`
    shapes and `I18nProvider`/`useAsync` patterns near-verbatim.
    `lib/auth/PlatformAuthContext.tsx` is a genuinely larger state machine
    than the portal's own `AuthContext` (password → MFA, several distinct
    steps, never a session from one call). The "who am I / MFA-verified"
    affordance is always visible (`Topbar`). RBAC hides actions, it
    doesn't just block them (no "New tenant"/"Suspend"/"Delete" buttons,
    no "Platform admins" nav item, for `PLATFORM_SUPPORT`). Impersonation
    UI shows the resulting token with a loud red warning banner + a
    dedicated cross-tenant session-history page. Country-pack config
    editing is a raw JSON textarea (functional over fancy for an internal
    authoring surface) validated both client-side (`JSON.parse`) and
    server-side (the existing schema).
  - **Two real bugs caught by the Playwright suite itself, both fixed**:
    (1) the login page's "redirect to /dashboard the instant a session
    exists" effect fired the MOMENT MFA enrollment succeeded, racing past
    the recovery-codes screen before an admin (or the test) could ever
    read/acknowledge it — fixed by excluding the `'recovery-codes'` step
    from that effect, letting its own "Continue" button navigate
    explicitly once acknowledged. (2) The tenant detail page's
    unconditional `if (loading) return <PageSpinner/>` unmounted the
    whole page (and any inline confirmation state, e.g. "Saved.") on
    every post-edit `reload()`, not just the initial load — fixed to
    `if (loading && !tenant)`, since `useAsync`'s `reload()` preserves the
    previous `data` while refetching.
  - Verified end-to-end over real HTTP by five new
    `apps/api/test/platform-*.e2e-spec.ts` files (41 tests: the full MFA
    state machine, THE CRITICAL authorization boundary — a valid TENANT
    token, and no token at all, both rejected on every platform route —
    least-privilege denial, tenant lifecycle including the
    suspend-blocks-login proof, usage metrics correctness, country-pack
    authoring/versioning/activation including the bypass-the-API malformed-
    row proof, and impersonation's full guarantee set) plus FOUR EXISTING
    e2e files (`licensing-saas`, `licensing-lifetime`, `resilience`,
    `audit`) updated to authenticate as a platform admin — they previously
    called `/platform/*` with no token at all, exactly the gap this step
    closes; `licensing-saas.e2e-spec.ts` gained two new boundary
    assertions. `apps/api`'s full suite: **423 tests green** (382
    existing/boundary + 41 new). A new `apps/admin/playwright.config.ts` +
    `tests/` suite (10 tests across `auth.spec.ts`/`tenants.spec.ts`/
    `rbac-and-country-packs.spec.ts`) drives the REAL enrollment/login/
    tenant-lifecycle/impersonation/country-pack-authoring UI in a real
    browser against the real stack — zero mocks, the same posture
    `apps/portal`'s own suite already takes. Full-repo `pnpm build` (6
    tasks) and `pnpm lint` (8 tasks) both green (packages/db gained
    `@node-rs/argon2` for its new `seedPlatformAdmin` dev-bootstrap
    seed).

- **4.2 — SaaS billing via Stripe, Phase 4's second slice — done.**
  SaaS-mode ONLY, per its own brief — lifetime/on-prem tenants stay
  entirely on the 0.6 signed-license path, verified by an e2e assertion
  that an AMC invoice never changes a tenant's `licenses` row count. See
  [`docs/conventions/billing.md`](./conventions/billing.md) for the full
  write-up; summarized here.
  - **Closes a real, previously-flagged gap.** 0.6's
    `FeatureFlagResolutionService.resolveSaas` has read `Subscription.status`
    correctly since it was written (TRIAL/ACTIVE = good standing,
    PAST_DUE/CANCELED = an empty, blocked flag set) — completely
    UNCHANGED by this step. What never existed until now was a real
    PRODUCER of that row outside a seed/test fixture. `StripeWebhookService`
    (authoritative, webhook-driven) and `BillingService` (optimistic,
    interactive) are now the sole producers, sharing ONE mapping function
    (`BillingService.applySubscriptionFromStripe`) so the two paths can
    never disagree on how a Stripe object maps onto this schema.
  - **Schema** (`packages/db`): `Subscription` gained
    `stripeCustomerId`/`stripeSubscriptionId`/`stripePriceId`/`quantity`/
    `currency`/`cancelAtPeriodEnd`/`trialEndsAt` (all nullable/defaulted —
    every pre-existing row keeps working unchanged). Three new tables:
    `Invoice` (Decimal money throughout, `type` SUBSCRIPTION/SETUP_FEE/AMC,
    `status` mirroring Stripe's own), `PaymentMethod` (display fields
    only — brand/last4/expiry, never a PAN), `BillingEvent` (the
    idempotency DB-level backstop, `@@unique([tenantId, stripeEventId])`).
    Two migrations (`add_billing_module`, `enable_rls_for_billing_module`)
    — the SAME two-migration pattern (schema, then RLS) every prior step
    since 3.3 already establishes.
  - **The Stripe seam** (`apps/api/src/billing/stripe/`) — a
    `STRIPE_CLIENT` Symbol-token interface naming ONLY the operations
    this module calls (not a full SDK mirror), the SAME shape
    `AUTH_PROVIDER`/`PAYROLL_PROVIDER_ADAPTER`/`ACCOUNTING_ADAPTER`
    already establish. `RealStripeClient` wraps `stripe@17` (pinned —
    later majors move `current_period_end`/`invoice.subscription` onto
    line items, a real breaking type change). `MockStripeClient` (bound
    whenever `STRIPE_SECRET_KEY` is unset, the default) is an in-memory,
    deterministic fake — its `webhooks.constructEvent` reuses 3.3's
    EXISTING outbound-webhook HMAC util verbatim, since Stripe's real
    webhook signature scheme (`t=<ts>,v1=<hmac>`) is identical to the one
    this codebase already uses for its own outbound webhooks.
  - **Seat metering reuses THE 0.6 seat-count** — `SeatCapService.check`
    was refactored to call a new `countActive` method, now shared by
    seat-cap enforcement, 4.1's usage metrics, AND this step's billing —
    one definition, never a second one drifting out of sync.
    `BillingSeatMeteringService` is a NEW daily scheduled BullMQ job (the
    SAME `onModuleInit` repeatable-job pattern 1.5's `AnalyticsRollupService`
    established) keeping Stripe's billed quantity in sync between
    explicit plan changes, deliberately un-prorated (`proration_behavior:
'none'`) so an employee joining mid-month never triggers a same-day
    surprise charge.
  - **Inbound webhooks** — the ONE inbound-webhook endpoint in this
    system, `POST /billing/webhooks/stripe`, `@Public()` (Stripe can't
    authenticate as a platform admin and there's no tenant header to
    resolve; tenant resolution happens INSIDE the service by looking up
    the event's own Stripe customer id, the same narrow cross-tenant
    lookup class `ApiKeyAuthService.validate` already establishes).
    `main.ts` gained `{ rawBody: true }` so signature verification runs
    against the EXACT bytes Stripe signed. TWO idempotency layers — 0.10's
    `IdempotencyService` (Redis) plus `BillingEvent`'s own unique
    constraint as the DB-level backstop, proven directly in the e2e suite
    by delivering an identical event twice and asserting exactly one
    `BillingEvent` row and one audit entry, not two. `billing.*` is
    DELIBERATELY NOT added to `DomainEventAuditListener`'s subscription
    list (unlike every other namespace) — the webhook service writes its
    own precise, before/after audit rows directly, the same more-explicit
    posture 4.1's `PlatformTenantService` already established over
    `LicensingAdminService`'s older generic-event-only one.
  - **PAST_DUE gates features; only a fully canceled subscription
    suspends the tenant** — a deliberate two-tier design: a lapsed card
    still lets an admin log in and fix payment (0.6's existing
    resolution already disables gated features); only Stripe's own
    terminal `customer.subscription.deleted` (after ITS OWN dunning
    retries) suspends the tenant, the real "non-payment can drive
    suspension" tie-in to 4.1's `TENANT_STATUS` enforcement. A real bug
    caught during development: the suspend write must go through the
    OWNER `prisma` client, not the tenant-scoped `tx` — `hrm_app` only
    has `SELECT` on `tenants`, so an early draft's `tx.tenant.update(...)`
    failed with `permission denied` the moment this path was actually
    exercised by a test.
  - **Money** — Decimal end to end (`toDecimalFromMinorUnits`, one
    conversion point, reused by the webhook sync, AMC invoicing, and the
    setup-fee charge). TWO different numbers, deliberately not conflated:
    a pure, unit-tested (`proration.util.spec.ts`, 6 tests, zero Stripe/DB
    dependency — the same "pure function, own spec file" posture
    `payroll-variables.util.ts` establishes) Decimal proration PREVIEW
    shown before a tenant confirms a plan change, vs. the AUTHORITATIVE
    charge Stripe itself computes, recorded only once the `invoice.*`
    webhook actually arrives. A one-time setup fee (`BILLING_PLANS`
    reference figures, `@hrm/shared`) fires only on a tenant's FIRST ever
    subscription, best-effort ONLY around the Stripe API call itself
    (nothing's touched Postgres yet if that fails) — the subsequent DB
    write is deliberately allowed to propagate rather than being
    (falsely) swallowed, since a failed statement aborts every later one
    in the same Postgres transaction regardless of a caught JS exception.
  - **AMC invoicing** (`PlatformBillingService.createAmcInvoice`,
    `platform.billing.manage`-gated, PLATFORM_OWNER only) — the
    lifetime-tenant bridge: an invoice-only Stripe charge, NO Subscription
    object involved, dual-audited exactly like 4.1's tenant-lifecycle
    actions (a real `platformAdminId` threaded through explicitly, unlike
    the webhook path's `actorPlatform: true` generic fallback).
  - **Surfaces**: `apps/portal`'s new `/billing` (RBAC-gated
    `billing.manage`, TENANT_ADMIN only — ownership/money territory,
    deliberately not in `HR_MANAGER`'s list) — plan/seats/proration
    preview/payment methods/invoices; payment-method collection is a
    plain token field (`pm_card_visa`-style), not a full Stripe Elements
    integration, the same "functional over fancy" posture 4.1's raw-JSON
    country-pack editor already takes. `apps/admin`'s new `/billing`
    (cross-tenant overview, cheap indexed read) plus a per-tenant Billing
    card (resync lever, AMC invoicing) on the existing tenant detail page.
  - Verified end-to-end over real HTTP by `apps/api/test/billing.e2e-spec.ts`
    (18 tests: `billing.manage` deny-by-default; live seat metering;
    upgrade/downgrade proration including a correctly negative downgrade
    credit; webhook signature rejection; an unmatched Stripe customer
    acknowledged and platform-audited rather than crashing;
    `customer.subscription.updated` (active) driving the REAL, unmodified
    0.6 entitlement pipeline end to end; a REDELIVERED webhook proven not
    to double-apply via both `BillingEvent` and `audit_log` row counts;
    PAST_DUE disabling features without suspending; a fully canceled
    subscription suspending the tenant, dual-audited; a multi-currency
    `eur` invoice recorded Decimal-correct; vendor-console read/manage
    RBAC including AMC invoicing never touching `licenses`; cross-tenant
    isolation for both interactive changes and inbound webhooks) plus
    `proration.util.spec.ts` (6 pure-function unit tests). `apps/api`'s
    full suite: **447 tests green** (423 existing + 6 new unit + 18 new
    e2e), zero regressions. Full-repo `pnpm build`/`pnpm lint` green
    across all 8 workspace tasks (added the real `stripe` npm package,
    pinned to v17). `apps/portal`'s existing 76-test and `apps/admin`'s
    existing 10-test Playwright suites both re-verified green, untouched
    by this step — no new Playwright coverage was written for the two
    new `/billing` pages in this pass (the task's own test list was
    backend-e2e-focused), a natural, documented follow-up.
- **4.3 — White-label / branding, Phase 4's final slice — done.** Lighter
  than 4.1/4.2 by design, per its own brief — mostly a tenant-configurable
  theming layer CONSUMING systems that already exist (tenant resolution,
  feature flags, notifications, audit, RLS), not a new subsystem. See
  [`docs/conventions/white-label.md`](./conventions/white-label.md) for
  the full write-up; summarized here.
  - **Per-tenant branding model** (`TenantBranding`, ordinary tenant-scoped
    RLS) — logo/favicon (via 1.1's `StorageService`, unmodified), colors,
    product name, login-page copy, email sender identity, and the gated
    full-rebrand bit. Absence means default (`DEFAULT_PRODUCT_NAME =
'HRM'`), the same posture `NotificationPreference` already takes for
    itself. Resolved through ONE service (`BrandingResolutionService`) —
    a genuine hot-path read (every page load, every outbound email, the
    pre-login screen) — cached in Redis (`REDIS_CLIENT`, 60s TTL,
    explicitly invalidated on every write), the same token
    `IdempotencyService`/`RateLimiterService` already use for
    cross-instance state, not a new caching subsystem.
  - **Theme tokens across portal, mobile, and email.** `GET /branding`
    (`@AllowAnonymous()`) + streamed logo/favicon downloads make the
    PRE-LOGIN screen brandable, since tenant resolution runs before auth.
    **A real bug this step's OWN Playwright suite caught and fixed**:
    `apps/portal`'s (and `apps/mobile`'s) `BrandingProvider` must
    RE-FETCH whenever the auth context's `user` changes, not just once on
    mount — this suite runs the HEADER tenant-resolution strategy (no
    stored slug at all until login), so the very first pre-login fetch
    legitimately 401s into plain defaults, and a fresh login showed the
    tenant's DEFAULT name instead of its branded one until this fix
    (`AuthContext.login()` stores the slug BEFORE updating `user`, so
    re-running the fetch on that transition is what closes the gap).
    Outbound email: `NotificationTemplateRenderer.render` now merges
    `{{productName}}` into every template's interpolation vars (reusing
    the EXISTING `interpolateTemplate`) — the two password-reset
    templates were updated from a hardcoded "HRM" to prove it for real;
    `NotificationDeliveryService` also resolves a branded
    `fromName`/`fromAddress` for the EMAIL channel.
  - **Branded custom domains extend the EXISTING 0.3 resolution
    strategy**, not a new one — `TenantDomain` gained
    `verificationStatus`/`certStatus` columns (still RLS-EXEMPT,
    necessarily) and `TenantResolutionService.resolveByCustomDomain` now
    requires `VERIFIED` before a domain resolves real traffic (proven:
    a freshly-requested domain 401s until approved). The write path goes
    through the OWNER `prisma` client, not `tx` — the same "RLS can't
    help on an RLS-exempt table" pattern `PlatformTenantService`/
    `StripeWebhookService` already use for `Tenant.status`, extended here
    to a genuinely new shape: an ordinary TENANT-authenticated route
    partially writing through the owner client. DNS TXT ownership
    verification (`DomainVerificationService`, Node's built-in
    `dns/promises`, no extra dependency) is the real production path; a
    loudly-audited manual `approve` override exists alongside it for the
    same reason 4.1's impersonation/4.2's `MockStripeClient` document a
    mock/manual fallback where a real external dependency (live DNS
    resolution to a fixture domain, here) can't be fully exercised in
    this sandboxed environment. TLS provisioning is a real, designed
    `CERT_PROVIDER` seam — `MockCertProvider` (default, issues
    immediately) vs. a documented-but-`NotImplementedException` real
    `AcmeCertProvider` (real ACME issuance genuinely can't be exercised
    here — no publicly resolvable domain or reachable challenge
    responder exists in this environment, unlike Stripe).
  - **Full rebrand is a SOLD, ENTERPRISE-only capability**
    (`FEATURE_FLAGS.FULL_REBRAND` in `EDITION_FEATURES`), gated behind the
    EXISTING `@RequireFeature`/`FeatureFlagGuard` (0.6) with zero bespoke
    entitlement logic — works identically for SaaS (`Subscription`) and
    lifetime (`License.enabledFlags`) tenants for free. Cosmetic branding
    (logo/colors/product name/domain) is available to EVERY tenant
    regardless of this flag — it only gates the "Powered by" vendor-
    identity footer (portal + mobile). The stored `fullRebrandEnabled`
    bit is intent only; `showPoweredBy` re-derives from the LIVE
    entitlement on every read (uncached, deliberately) — proven directly
    by downgrading an entitled tenant's subscription and confirming the
    footer reappears immediately, with zero change to the stored bit.
  - **Vendor oversight** (`apps/admin`'s new `/branding` + a per-tenant
    branding card) — `BRANDING_READ` (both platform roles) /
    `BRANDING_MANAGE` (PLATFORM_OWNER only), the SAME split
    `BILLING_READ`/`BILLING_MANAGE` already established in 4.2. Every
    mutation (verify/approve/provision-tls/reset) is dual-audited exactly
    like 4.1/4.2's own platform-triggered tenant actions — the target
    tenant's own `audit_log` AND the platform's `PlatformAuditLog`, never
    silent, proven by reading the tenant's own audit trail after a
    vendor-console action in the Playwright suite.
  - **Surfaces**: `apps/portal`'s new `/branding` (RBAC-gated
    `branding.manage`, TENANT_ADMIN only — ownership territory, same
    reasoning `billing.manage`/`license.manage` already document) — logo/
    favicon upload, colors, product name, login copy, email identity, a
    custom-domain request-with-DNS-instructions flow, and the
    entitlement-aware rebrand toggle. `apps/mobile` consumes the same
    resolved branding (product name/colors/login copy/"Powered by") via
    its own mirrored `BrandingProvider`, deliberately NOT fetching the
    logo/favicon image itself (a documented gap, not an oversight).
  - Verified end-to-end over real HTTP by
    `apps/api/test/white-label.e2e-spec.ts` (21 tests: public defaults,
    RBAC deny-by-default on every mutation, an immediate-reflect update,
    cross-tenant isolation, a byte-for-byte logo upload→download round
    trip, a branded product name actually appearing in a real outbound
    password-reset email's subject, full-rebrand deny/allow/LIVE-
    re-check-on-downgrade, a custom domain unresolvable-until-verified
    then genuinely resolving the right tenant, a second tenant blocked
    from claiming an already-requested domain, PLATFORM_SUPPORT denied
    every MANAGE action, TLS refused-before-verified then succeeding,
    the target tenant's own audit log showing a platform action, and a
    full platform-triggered reset). `apps/api`'s full suite: **468 tests
    green** (447 existing + 21 new), zero regressions. `apps/portal`'s
    Playwright suite grew to **82 tests** (76 existing + 6 new — an
    admin's real-UI branding update reflected with NO reload via the
    shared provider's `refresh()`, a reload re-resolving from the server,
    cross-tenant isolation, branding correctly coexisting with `dir=
"rtl"` for a QA-branch employee, RBAC deny, and the "Powered by" footer
    visible by default); one pre-existing, unrelated
    `operations-modules.spec.ts` test flaked once under full-suite load
    and passed cleanly in isolation — the same class of test-parallelism
    flakiness this log already documents elsewhere, nothing to do with
    branding. `apps/admin`'s Playwright suite grew to **14 tests** (10
    existing + 4 new — the overview listing a pending domain,
    PLATFORM_SUPPORT seeing-but-not-acting, an owner approving +
    provisioning TLS with a real audit-trail proof, and a full reset).
    `apps/mobile` re-verified unchanged at **19/19** (`tsc`/`eslint`/
    `expo export` also re-confirmed clean — no simulator available in
    this environment for visual verification, the same documented limit
    1.4 already established). Full-repo `pnpm build`/`pnpm lint` green
    across all 8 workspace tasks.

**PHASE 4 COMPLETE.** Vendor super-admin console (4.1) + SaaS billing via
Stripe (4.2) + white-label/branding (4.3) — the platform is now a
commercially operable SaaS AND on-prem product: a vendor can provision/
suspend/bill tenants and author country packs from `apps/admin`; a SaaS
tenant subscribes, upgrades, and pays through real Stripe-driven
entitlement; and any tenant — SaaS or lifetime — can present the product
under its own name, colors, domain, and (if entitled) fully white-labeled
identity.

## 3.5.1 — Data migration & onboarding toolkit

Phase 3.5's first slice (go-live enabler, numbered ahead of Phase 5's scale
work per the task brief) — `packages/db`, `packages/shared`, `apps/api/src/migration`,
`apps/api/src/platform/migration`, `apps/portal/src/app/(app)/migration`,
`apps/admin/src/app/(app)/migration`. See
[`docs/conventions/data-migration.md`](./conventions/data-migration.md) for
the full write-up. Imports a new client's EXISTING employee/HR data
(CSV/XLSX) — the SAME thin-consumer posture 3.1's operations modules
established: this toolkit owns ZERO employee/leave/country-pack validation
logic of its own, routing every write through the REAL 1.1 `EmployeeService`
and 1.2 `LeaveBalanceService` (the latter additively exported this step).

- **Two-phase `ImportBatch`, a real state machine** —
  `UPLOADED -> VALIDATING -> DRY_RUN_COMPLETE -> COMMITTING ->
COMMITTED`/`COMMITTED_WITH_ERRORS`/`FAILED`. `POST /migration/batches/:id/commit`
  is refused (`409`) unless `status = DRY_RUN_COMPLETE` — THE first of two
  idempotency layers; the second is DATA-level, every importer resolving its
  target row by NATURAL KEY (employeeCode, branch/department/designation
  name, cost-center code) and upserting, so even a brand-new batch importing
  the same file twice updates instead of duplicating.
- **The dry-run mechanism — zero duplicated validation logic.** Every
  importer's `processRow` calls the REAL service either way; `runImportRow`
  (`migration-row-runner.ts`) is what makes a DRY RUN trustworthy: it runs
  the exact same call inside its own `withTenantContext` transaction, then
  deliberately throws a private sentinel wrapping the result to force
  Postgres to roll the transaction back regardless of outcome — a dry run
  can never write to a target entity table, by construction, not by
  convention. A COMMIT runs the identical call with no rollback, one
  transaction per row (the same per-row-isolation shape 1.1's
  `EmployeeImportProcessor` already established).
- **Importers**: BRANCH/DEPARTMENT/DESIGNATION/COST_CENTER (plain reference
  tables, no dedicated service exists, so these write directly, natural-key
  upsert); EMPLOYEE (the primary one — routes through `EmployeeService.create`/
  `.update`, so country-driven required fields, encryption, and custom
  fields are enforced identically to a direct `POST /employees` call);
  LEAVE_BALANCE (routes through `LeaveBalanceService.getOrCreateBalance` +
  a NEW additive `setOpeningBalance` method — a genuine SET of the client's
  current accrued/carried-over totals, deliberately different from the
  existing `adjust()` action's DELTA semantics); ATTENDANCE_HISTORY/
  PAYSLIP_HISTORY (explicitly scoped down per the brief — READ-ONLY
  historical records in two NEW, purpose-built tables,
  `MigratedAttendanceSummary`/`MigratedPayslipRecord`, deliberately NOT the
  real `AttendanceDailySummary`/`PayrollRun` tables, which are freely
  recomputed/tax-and-statutory-engine-driven — this toolkit never
  recomputes historical payroll or attendance).
- **Manager-by-employeeCode linking — the one explicitly-named cross-row
  case.** `EntityImporter.finalize` is an optional second pass over every
  STAGED row, run only after all of them exist (or would exist, for a dry
  run) — `EmployeeImporter` uses it to resolve `managerEmployeeCode` even
  when the manager's own row appears LATER in the file than its reports.
  A finalize failure (an unresolvable manager code) is a SEPARATE row error
  from the employee's own create/update outcome — the employee still gets
  created even if only its manager link fails to resolve.
- **Column mapping** (`{ourFieldKey: "client's column header"}`) —
  `IMPORT_ENTITY_FIELDS` (`@hrm/shared`) is the one field catalog both the
  backend (`assertColumnMappingComplete`, rejecting an incomplete mapping
  BEFORE any file parsing) and the portal/admin mapping-step UI read from.
  `ColumnMappingTemplate` (tenant-scoped, `@@unique([tenantId, entityType, name])`)
  makes a mapping reusable across repeat imports.
- **File handling** — CSV via the EXISTING `csv-parse` dependency (1.1);
  XLSX via a NEW dependency, `xlsx` (SheetJS), added to `apps/api` AND (for
  client-side header detection before any upload) `apps/portal`/`apps/admin`
  — both formats normalize to the same all-string-values row shape, so
  every downstream coercion is format-agnostic. Uploaded files are stored
  via 1.1's EXISTING `StorageService` (`migration/<tenantId>/<batchId>/<fileName>`)
  and PURGED (`MigrationPurgeService`, a manual-trigger sweep — the SAME
  "not wired to a scheduler yet" tradeoff 0.7/1.2/1.3/3.1 already take) once
  a batch reaches a terminal state and `IMPORT_FILE_RETENTION_HOURS`
  (default 72h) elapses — raw uploaded PII does not live in object storage
  indefinitely. `StorageService` gained one additive method,
  `deleteObject` — the first caller in this codebase that ever needed to
  remove a stored object rather than only write/read one.
- **BullMQ, one queue, two job names.** `migration` (`MigrationProcessor`)
  handles both `validate` and `commit` jobs, forwarding to
  `MigrationProcessingService` — the SAME reusable pattern every prior
  BullMQ-backed module already established (see `QueueModule`'s doc
  comment), sharing one processor rather than two nearly-identical ones.
- **Row-level error reporting** — `ImportRowError` (a real table, not a
  growing JSON blob on `ImportBatch`) holds the mapped row data next to a
  plain-language reason; `GET /migration/batches/:id/report` streams a CSV
  (columns = the entity's own field catalog + `message`) a client can open
  directly to see their own values next to why each row failed.
  `mode: PARTIAL` (default) imports valid rows and reports the rest;
  `ALL_OR_NOTHING` refuses to commit at all (nothing written) if the last
  dry run found any row error.
- **Who runs it** — tenant self-serve (`apps/portal`'s new `/migration`
  wizard: upload -> map -> dry run -> review -> commit -> download report,
  RBAC-gated on a NEW `migration.manage` permission, TENANT_ADMIN + HR_MANAGER)
  and vendor/platform-admin-on-a-tenant's-behalf (`apps/admin`'s new
  `/migration` page, a NEW `PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE`
  held by BOTH platform roles — the same onboarding-support risk tier
  `IMPERSONATION_START` already documents). A platform-triggered batch
  reuses `ImportBatchService` UNCHANGED, opened via `withTenantContext`
  (RLS still enforced, defense-in-depth) rather than the owner `prisma`
  client platform services usually reach for — and is DUAL-audited exactly
  like 4.1/4.2/4.3's own platform-triggered tenant actions (the platform's
  own `PlatformAuditLog` AND, via the EXISTING `AuditRecordService.recordForTenant`,
  the TARGET TENANT's own `audit_log`, `initiatedByPlatformAdminId` visible
  on the batch row itself).
- **A real, general bug caught and fixed while writing the Playwright
  suite**: `packages/shared`'s `messages.ts` catalog gained new
  `migration.status.*`/`nav.migration`/etc. keys, but `apps/portal`
  resolves them from `packages/shared`'s COMPILED `dist`, not its source —
  the portal build silently rendered the literal `[[migration.status.DRY_RUN_COMPLETE]]`
  fallback string (this catalog's own documented "missing from every
  locale" behavior) until `packages/shared` was rebuilt. Not a code bug,
  but a real, easy-to-repeat monorepo-workflow trap worth recording:
  editing `packages/shared/src/**` requires `pnpm --filter @hrm/shared build`
  before any consuming app's dev/build/test run will see it.
- **Known, documented gaps for this phase** (not required by this step's
  brief, flagged so they aren't silently forgotten): importing does not
  itself enforce per-branch data scoping on the CALLER (`allowedBranchIds`
  is threaded through every importer as `null`/unrestricted) — accepted
  since `migration.manage` is already TENANT_ADMIN/HR_MANAGER-only,
  tenant-setup territory rather than a routine branch-scoped HR workflow;
  `ATTENDANCE_HISTORY`/`PAYSLIP_HISTORY` have no natural key of their own
  (a pure append log), so re-importing the same historical file as a
  BRAND-NEW batch appends duplicates — the batch-status-guard idempotency
  layer still fully covers "committing the SAME batch twice," just not
  "uploading the same file twice as two different batches," for these two
  entity types only; `MigratedPayslipRecord.grossPay`/`.netPay` are
  field-level gated behind `salary.view` but, unlike
  `Employee.baseSalaryEncrypted`, NOT encrypted at rest (an honest,
  documented asymmetry for what is explicitly scoped-down historical
  reference data); `ALL_OR_NOTHING` is gated at commit-START against the
  last dry run's `errorCount` rather than one giant all-rows-or-nothing
  transaction (which would reintroduce the long-transaction/connection-pool
  risk 0.10 specifically protects against) — a row that passes dry-run but
  fails at the moment of commit (e.g. a referenced branch deleted in
  between) is still recorded as a per-row error rather than rolling back
  every already-committed row in that same batch, a narrow, documented
  race; no department targeting/picker changes were needed (this module
  doesn't touch departments beyond importing them).
- Verified end-to-end over real HTTP by `apps/api/test/migration.e2e-spec.ts`
  (10 tests: a dry run leaving `branches` untouched then a commit writing
  it with a REAL non-identity column mapping honored; re-committing an
  already-committed batch refused and non-duplicating; a messy EMPLOYEE
  file where a US row missing SSN/W4 and a QA row missing QATAR_ID both
  fail with a clear reason while the valid US/QA rows commit through the
  real country-pack-driven path; manager-by-employeeCode linking resolving
  correctly even when the manager's row appears AFTER its report's;
  LEAVE_BALANCE opening-balance import setting `accruedDays`/
  `carriedOverDays` exactly via the real `LeaveBalanceService`; a saved
  column-mapping template listed and reused; RBAC deny-by-default; and
  cross-tenant isolation — RLS, not application code, blocking tenant B
  from reading tenant A's batches) plus `apps/portal/tests/migration.spec.ts`
  (3 Playwright tests: the full upload -> map -> dry-run -> review ->
  commit -> CSV-report-download flow through the real UI against a messy
  file, a saved mapping template reused for a second import, and a plain
  EMPLOYEE seeing no "Data import" nav entry). `apps/api`'s full suite:
  **478 tests green** (468 existing + 10 new). `apps/portal`'s Playwright
  suite: **85 tests** (82 existing + 3 new); one pre-existing, unrelated
  `operations-modules.spec.ts` test flaked once under full-suite load and
  passed cleanly both in isolation and as part of its own serial block —
  the SAME class of test-parallelism flakiness this log already documents
  for itself in 4.3, nothing to do with this step. `apps/admin` gained a
  new onboarding `/migration` page (build/lint verified clean; no new
  Playwright spec for it this step — the identical dry-run/commit/report
  code path is already fully proven by both the backend e2e suite's
  platform-admin scenario and the portal's own Playwright spec). Full-repo
  `pnpm build`/`pnpm lint` green across all workspace tasks.
- **3.5.2 Benefits administration — done — 2026-09-08.** See
  [`docs/conventions/benefits.md`](./conventions/benefits.md) for the full
  write-up. Backend (`packages/db`, `packages/shared`, `apps/api/src/benefits`)
  - portal UI (`apps/portal`) together, the SAME "thin module, consumer of
    systems that already exist" posture 3.1's four operations modules
    established: `BenefitPlan`/`BenefitPlanTier` (tenant-configurable cost
    structure mirroring `PayrollComponentDefinition` field-for-field —
    `FIXED_AMOUNT`/`PERCENTAGE_OF_BASE`/`FORMULA`, `FORMULA` reusing 0.5's
    closed `Expr` AST as-is), `BenefitEnrollment`/`BenefitEnrollmentDependent`
    (admin-assigned or ESS self-elected, reusing 1.1's `EmployeeDependent`
    directly, optional approval via a REAL 0.7 `WorkflowInstance`,
    `entityType: "BENEFIT_ENROLLMENT"` — THE RULE, zero bespoke approval
    logic), `BenefitContributionRecord` (the per-period payroll-input proof
    row). THE BOUNDARY, same shape as payroll.md's own: this module never
    computes pay — `PayrollRunProcessor` gained one additive
    `mergeBenefitContributions` step (imported as PURE functions from
    `apps/api/src/benefits/benefits-payroll-input.util.ts`, no NestJS
    module coupling either direction) mirroring the 3.1 expense-
    reimbursement hand-off exactly, `PayrollEngineService` itself completely
    untouched. Country-mandated STATUTORY schemes need NO new payroll-side
    wiring at all — `PayrollEngineService` already applies every resolved
    CountryPack `statutory.components` entry generically (employee AND
    employer sides alike) since 0.5/2.1; this step's own statutory surface
    (`BenefitsStatutoryService`) is READ-ONLY visibility, calling Payroll's
    own `resolvePayrollPackConfig` directly. Proven with real, asymmetric
    employee/employer statutory data added to BOTH reference packs for the
    first time (US gains an EMPLOYEE-side `state_disability_insurance`
    alongside the pre-existing employer-only `futa`; Qatar gains a `BOTH`-
    sided `grsia_pension_employee`/`_employer` pair, closing a gap the QA
    pack's own comment had explicitly flagged as "deliberately out of
    scope" since 0.5) — required updating five pre-existing tests'
    hardcoded net-pay/statutory-component-list assertions across
    `payroll.e2e-spec.ts`, `country-packs.e2e-spec.ts`,
    `operations-modules.e2e-spec.ts`, `recruitment-lifecycle.e2e-spec.ts`,
    and `statutory-calculator.spec.ts` to account for the new components —
    a real, foreseeable ripple effect of extending shared reference-pack
    fixtures, caught and fixed, all now passing with the new numbers. A
    THIRD country (Pakistan, EOBI-style, asymmetric 1%/5% employee/employer)
    proves the divergence generically without touching either shipped
    reference pack — an ad-hoc test-only `CountryPack` row, the SAME
    "test-specific fixture, never touching seed-country-packs.ts" precedent
    payroll.e2e-spec.ts's own DELEGATE-mode pack already established.
    Cost reporting (`BenefitsCostReportService`) reads ALREADY-COMPUTED data
    only — plan totals from `BenefitContributionRecord`, statutory totals
    read back out of the SAME `PayrollRunLine.componentBreakdown` the
    engine already produces (filtered to exclude this module's own
    `benefit_*`-keyed lines, which would otherwise double-count the
    employer-share plan totals) — never a second aggregation/rollup table,
    since one branch/period's headcount is a bounded, cheap live query, the
    same "no rollup needed yet" scope call 3.1's own cost surfaces make for
    themselves. Money fields (`BenefitContributionRecord`/cost-report
    amounts) are field-level gated behind `salary.view`, the SAME existing
    `PermissionSerializerInterceptor`/`@RequiresPermission()` mechanism
    every other salary-adjacent DTO uses; an employee's OWN
    `GET /benefits/my-benefits` stays ungated — "your own data is never out
    of scope." New RBAC: `benefits.read`/`benefits.enroll` (seeded onto
    every role including EMPLOYEE) vs. `benefits.manage` (TENANT_ADMIN/
    HR_MANAGER). Portal: `/benefits` (ESS — available plans, elect,
    dependents, my enrollments) and `/benefits/admin` (plan authoring —
    `FORMULA` plans deliberately NOT authorable through this form, the SAME
    documented gap `payroll.ts`'s own `UpsertPayrollComponentInput` already
    carries; enroll-any-employee; statutory scheme viewer by branch; cost
    report), a new Sidebar entry in both the ESS and admin nav sections.
    Deferred, documented seams (per this step's own scope line): no
    provider-integration adapter (a real insurance-carrier API) and no
    complex open-enrollment-WINDOW machinery (effective-dated enrollment
    rows exist; a scheduled "enrollment period opens/closes" job does not).
    Verified end-to-end over real HTTP by `apps/api/test/benefits.e2e-spec.ts`
    (14 tests: FIXED_AMOUNT/PERCENTAGE_OF_BASE/FORMULA/tiered plan
    configuration each producing the correct Decimal employee-deduction +
    employer-contribution pair in a real payroll run without touching the
    engine; a tiered plan's dependent + coverage-tier selection changing the
    resulting cost; a third-country (Pakistan) statutory contribution
    computed by the identical engine as Qatar's, both differing correctly
    from the SAME `GET /benefits/statutory` endpoint; enrollment approval
    via the real 0.7 workflow gating whether a payroll run picks it up at
    all; branch-scoped cost reporting combining plan + statutory totals with
    no double-counting, field-omitted for a caller without `salary.view`;
    deny-by-default RBAC on plan authoring/enrolling-on-behalf/cost
    reporting; cross-tenant isolation via RLS) plus five pre-existing test
    files' updated assertions (see above). `apps/api`'s full suite: **493
    tests green** (479 existing + 14 new). `apps/portal/tests/benefits.spec.ts`
    (5 Playwright tests: admin authoring a FIXED_AMOUNT and a tiered plan;
    a manager adding a real dependent via their own profile then electing
    the FAMILY tier with it covered; a plain employee self-electing a
    simple plan; the statutory-scheme panel showing different components
    for a QA vs. a US branch; a QA-branch employee rendering the page
    right-to-left) — the payroll-input/statutory-divergence/cost-report MATH
    is proven at the API level already, so this suite only proves UI WIRING,
    the same posture every prior console's own Playwright spec already
    takes. `apps/portal`'s full Playwright suite: **90 tests** (85 existing +
    5 new); one pre-existing, unrelated `operations-modules.spec.ts` test
    flaked once under full-suite load and passed cleanly in isolation — the
    SAME class of test-parallelism flakiness this log already documents for
    itself in 3.5.1/4.3, nothing to do with this step. Full-repo `pnpm
build`/`pnpm lint` green across all eight workspace tasks.
- **3.5.3 E-signatures — done — 2026-09-09.** See
  [`docs/conventions/e-signatures.md`](./conventions/e-signatures.md) for
  the full write-up. Backend (`packages/db`, `packages/shared`,
  `apps/api/src/esignature`) + portal UI (`apps/portal`) together, the
  SAME "thin module, consumer of systems that already exist" posture every
  prior 3.x slice has established — storage (1.1), PDF generation
  (2.1's `pdfkit`/bundled-DejaVu-font approach, reused byte-for-byte),
  audit (0.9's `audit_log` DB-immutability pattern, applied a second time),
  notifications (0.8, plus one direct-provider-call exception for
  non-`User` recipients), and the two real integrations (Offer/Policy).
  THE CORE CLAIM this step actually builds toward: `SignatureRequest`
  (polymorphic `entityType`/`entityId`, no FK — same shape
  `WorkflowInstance` already establishes) + `SignatureSigner` (`INTERNAL` —
  a real `User`, ESS-reachable; `EXTERNAL` — no account at all, reached
  only via a scoped, expiring, single-document capability token, the SAME
  indexed-prefix + argon2id-hash pattern 3.3's `ApiKeyService` already
  establishes, never a JWT/RBAC credential) + an append-only
  `SignatureEvent` trail made DB-IMMUTABLE via the identical `audit_log`-
  style `REVOKE UPDATE/DELETE` migration (proven directly against Postgres
  by a new `packages/db/test/signature-event-immutability.spec.ts`, the
  same proof shape `audit-log-immutability.spec.ts` already established) +
  a generated `SignatureCertificate` PDF as a SEPARATE downloadable
  artifact. A `SIGNED` event captures identity, UTC timestamp, IP/
  user-agent, signing method, AND a FRESH SHA-256 re-hash of the document's
  current bytes at that exact instant — never just copied from the
  request's own creation-time hash — which is what makes a later
  `GET /e-signatures/requests/:id/verify` tamper-evidence re-check
  meaningful rather than circular. Sequencing (parallel-by-shared-`order`,
  sequential-by-differing-`order`) is its OWN small mechanism
  (`SigningProgressService`), deliberately NOT the 0.7 workflow engine —
  signing is an action, never a multi-step approve/reject/delegate/
  escalate DECISION, the identical justification 2.3's checklist
  mini-engine already gives relative to `ApproverRule`. Two real
  integrations, both additive: an Offer's acceptance IS its signature —
  `EsignatureCompletionSideEffectsListener` (reacting to
  `esignature.completed`, the same fire-and-forget cross-module event-
  listener shape this codebase always uses) calls the REAL, UNMODIFIED
  `OfferService.accept`, which already cascades into 2.3's EXISTING
  onboarding trigger (`recruitment.offer_accepted` →
  `OnboardingOfferAcceptedListener`) with ZERO changes to
  `apps/api/src/recruitment`/`apps/api/src/onboarding`; `Policy` gains one
  additive `requiresSignature` column and `PolicyService.acknowledge` gains
  one additive `bypassSignatureRequirement` parameter, so a signed
  acknowledgment produces the IDENTICAL `PolicyAcknowledgment` row the old
  click-based flow always did (existing admin tracking needs zero
  changes), plus the full trail — an employee self-requesting their OWN
  policy signature is a row-level carve-out on `esignature.request`'s
  permission check (a `POLICY_READ` holder naming themselves as the sole
  signer), the SAME "gated at the row level, an explicit manage-tier
  permission widens who may act" shape `InterviewScorecard` submission
  already establishes. External-signer email delivery calls the 0.8 hub's
  `EMAIL_PROVIDER` DIRECTLY (one additive `NotificationsModule` export)
  since that hub's whole recipient/preference/locale model is `User`-keyed
  and an external signer has none. THE HONEST COMPLIANCE BOUNDARY, stated
  directly in the portal UI: this is a strong, tamper-evident evidentiary
  MECHANISM, not a legal determination of sufficiency under any specific
  e-signature law (eIDAS/ESIGN/UETA/etc.) — that determination is for the
  contracting parties and their counsel, the SAME framing payroll.md/
  benefits.md already take for their own domains. A documented, deliberate
  seam for a future real e-sign vendor (DocuSign/Adobe Sign/etc.) — the
  SAME "swap one DI binding" shape every other adapter in this codebase
  takes — is written up but not built. Portal: `/esignature` (admin
  tracking + create, gated `esignature.manage`/`.request`), `/esignature/[id]`
  (signer list, evidentiary-trail timeline, document/certificate downloads,
  a live verify-integrity button), `/esignature/my` (ESS pending-signature
  inbox + a shared `SignaturePad` component — typed name or a drawn
  canvas signature), and `/esign/[token]` (the PUBLIC external-signer
  page, deliberately outside the `(app)` route group — no session, no
  sidebar, the SAME shape `/login` already establishes — storing the
  emailed link's `?tenant=` query param via the existing
  `setStoredTenantSlug()` before making any API call). The ESS
  announcements page's policy-acknowledge button now reads "Sign to
  acknowledge" and routes into this flow whenever a policy requires it.
  New RBAC: `esignature.request`/`.manage` (`TENANT_ADMIN`/`HR_MANAGER`)
  and `esignature.sign` (seeded onto every role including `EMPLOYEE`).
  Deferred, documented gaps (per this step's own scope line): no real
  e-sign PROVIDER adapter; generated documents (offer letters, policy
  text, CUSTOM) always render in English regardless of the resolved
  branch locale (unlike `PayslipPdfService`'s own pack-driven-language
  precedent); no reminder/escalation sweep for a signer who never acts; no
  picker abstraction for offer/policy ids in the admin create form (type
  the id, the same documented posture interviewer/manager pickers already
  carry); no qualified/certificate-based (PKI) signing method. Verified
  end-to-end over real HTTP by `apps/api/test/esignature.e2e-spec.ts` (21
  tests: an internal signer's full evidentiary trail captured on signing
  with a certificate generated on completion and a live tamper-evidence
  check correctly flipping to invalid after the stored document is
  overwritten out-of-band; an external candidate signing a generated offer
  letter via a token-only link with NO account, flowing into the REAL
  `OfferService.accept` → `recruitment.offer_accepted` →
  `OnboardingOfferAcceptedListener` chain with zero Recruitment/Onboarding
  changes; the external token proven NOT a general credential (rejected as
  a Bearer JWT), NOT cross-tenant (RLS — the identical token 404s under a
  different tenant Host), and expiring (410 Gone); a `requiresSignature`
  policy refusing a plain click and accepting a real signed acknowledgment
  via the row-level `POLICY_READ` self-service carve-out, with that
  carve-out correctly forbidden on someone else's behalf; RBAC deny-by-
  default on both creation and tenant-wide listing; cross-tenant isolation
  via RLS) plus `packages/db/test/signature-event-immutability.spec.ts` (5
  tests: the identical `audit_log`-style DB-level REVOKE UPDATE/DELETE
  proof, applied to `signature_events`). `apps/api`'s full suite: **514
  tests green** (493 existing + 21 new). `apps/portal/tests/esignature.spec.ts`
  (5 Playwright tests over the real browser/API/Postgres/Redis/MinIO
  stack: an admin creating and sending a request through the real UI, the
  employee signing it from `/esignature/my` with a typed signature, the
  admin seeing it COMPLETED with the live verify check reporting valid,
  RBAC-gated nav visibility, and a QA-branch employee rendering the
  signing page RTL) — a real bug this step's own test-writing caught and
  fixed, worth recording: polling a detail page's status by repeatedly
  `page.goto()`-ing the SAME URL in a loop is itself a bug, not a
  reasonable wait strategy — each is a FULL browser navigation, re-running
  `AuthProvider`'s bootstrap/refresh-token exchange every single time,
  which can trip 0.4's refresh-token reuse detection — the exact "one
  login/navigation burst per test" lesson operations-modules.md /
  frontend-admin-console.md already document for a related flakiness
  class; fixed by asserting once after a single navigation, since the
  prior test's `sign()` call had already awaited full completion
  (including certificate generation) synchronously server-side before its
  own response returned — there was nothing left to poll for.
  `apps/portal`'s full Playwright suite: **95 tests** (90 existing + 5
  new). Full-repo `pnpm build`/`pnpm lint` green across all eight
  workspace tasks.

## 5.1 — Data-layer scale hardening

Phase 5's first slice (2026-09-09) — `docker-compose.yml`,
`docker/postgres-replica/`, `docker/postgres-primary-init/`, `packages/db`,
`apps/api/src/tenancy`, `apps/api/src/country-packs`, `apps/api/src/auth`,
`apps/api/src/migration`. See
[`docs/conventions/scaling-data-layer.md`](./conventions/scaling-data-layer.md)
for the full write-up. Goal: the database is never the bottleneck at
scale, while RLS/tenant-isolation and correctness are fully preserved —
every optimization here is provably isolation-preserving, verified against
REAL local infra (a real PgBouncer, a real Postgres streaming replica),
never simulated.

**Connection pooling**: a real `pgbouncer` service (transaction pooling
mode) added to docker-compose, fronting the SAME primary. THE #1 risk of
this step — proven, not just argued: `current_tenant` is set via
`set_config(..., true)` inside the same transaction PgBouncer scopes a
backend connection to, so it resets at COMMIT/ROLLBACK atomically with
the connection returning to the pool — no window exists for tenant
context to leak across a reused connection.
`packages/db/test/pgbouncer-rls.spec.ts` fires 60 concurrent, tenant-A/
tenant-B-interleaved transactions through a deliberately 3-connection pool
and proves zero leakage; `apps/api/test/resilience-pgbouncer.e2e-spec.ts`
repeats the proof at the full HTTP level and additionally proves 0.10's
pool-exhaustion 503+Retry-After backpressure still works through the
pooler. Local dev/test's OWN default `APP_DATABASE_URL` deliberately stays
a DIRECT connection, not the pooler, despite the pooler being fully
proven — an empirical finding, not caution for its own sake: routing the
FULL 514-test suite through it passed 513/514 (zero new regressions,
same pre-existing flake), but an isolated look at `migration.e2e-spec.ts`
(many small sequential transactions in a tight polling loop) showed
measurably higher per-transaction latency through the pooler, enough to
occasionally push that ALREADY timing-sensitive test past its own
deadline — a real, documented characteristic of transaction-mode pooling,
not a correctness bug, and exactly why this ships as a proven, config-only
production cutover (`APP_DATABASE_URL` pointed at the pooler,
`?pgbouncer=true` required) rather than a silent default-topology change.

**Read replicas**: `docker/postgres-replica/` is a GENUINE Postgres 16 hot-
standby (`pg_basebackup -R` self-bootstrap on first start, real streaming
replication, real `wal_level=replica`/`max_wal_senders` on the primary) —
not a mock. `packages/db`'s `appReadReplicaPrisma`/`withReplicaTenantContext`
reuse `withTenantContext` verbatim against a different client — RLS needed
ZERO new logic, since `current_tenant` is a per-transaction Postgres
setting, orthogonal to WAL streaming. `ReplicaReadService`
(`apps/api/src/tenancy`) is the one explicit opt-in seam a caller uses for
a read it knows is safe to be stale (the worked example:
`AnalyticsController`'s dashboard, which only ever reads precomputed
rollups); read-your-own-write paths are completely unchanged, still the
primary by default. `packages/db/test/read-replica.spec.ts` proves RLS
holds identically on the replica, that it genuinely rejects writes at the
Postgres engine level, and — the definitive read-after-write proof —
deliberately PAUSES WAL replay (`pg_wal_replay_pause()`), writes on the
primary, confirms the primary read sees it instantly while the
provably-lagging paused replica does not, then resumes and confirms the
replica catches up on its own.

**Caching**: three tenant-scoped Redis caches, all following 4.3's
`BrandingResolutionService` shape (short TTL as a backstop, immediate
invalidation on write as the real mechanism) — resolved country packs
(`CountryPackResolutionService`, invalidated by both a tenant's own
override write and a platform-admin global pack-version change),
org/branch structure (`OrgStructureCacheService`, invalidated by the one
real write path onto `Branch` — the 3.5.1 migration importer's commit),
and permissions (`PermissionsCacheService`, wrapping `loadUserContext`,
THE hottest read in the system — resolved on every authenticated request
inside `TenantScopeInterceptor`; honestly documented as having no real
mutation-endpoint hook yet, since none exists in this codebase, so its 15s
TTL is today's primary staleness bound for that one gap, not just a
backstop). **A fourth cache — feature-flag/entitlement resolution — was
built, wired into `FeatureFlagGuard`, and then REVERTED after the existing
`licensing-saas.e2e-spec.ts` suite (which legitimately writes `Subscription`
rows directly, bypassing the cache's only two invalidation hooks) proved
it could serve a stale, pre-change entitlement — exactly the security
concern this step's own brief warns against.** `FeatureFlagGuard` was
restored to its pre-step, fully-fresh-every-call behavior with zero net
change — a real, empirically-forced finding recorded prominently in the
convention doc, not a theoretical caveat. Every cache is proven both
ways in `apps/api/test/scaling-data-layer.e2e-spec.ts` (5 tests): a write
takes effect on the VERY NEXT read, and one tenant's (or tenant+user's)
cached value never leaks to another.

One full-suite run showed `migration.e2e-spec.ts` itself passing clean but
`scaling-data-layer.e2e-spec.ts`'s own branch-import cache-invalidation
test flaking instead — expected, not a new problem: it exercises the
IDENTICAL async migration-processing pipeline that file's own known flake
already comes from, so it inherits the same full-suite-parallel-load
timing sensitivity, confirmed unrelated to the caching logic itself by an
isolated rerun (5/5 green in 7.5s).

Scope discipline: RLS policies, `withTenantContext`'s core mechanism,
`TenantScopeInterceptor`'s resolution/auth ordering, the 0.10 resilience
chassis (rate limiting/circuit breakers/load shedding/idempotency), and
every existing module's business logic are all completely unmodified —
this step is additive infrastructure, not a redesign. No schema migration
was needed. Verified: `packages/db`'s full suite — **28 tests green** (22
existing + 6 new, across the two new spec files above), against real
local Postgres/replica/PgBouncer infra. `apps/api`'s full suite — **521
tests green** (514 existing + 2 new e2e files, 7 new tests), with the same
single pre-existing `migration.e2e-spec.ts` timing flake this suite
already carries (confirmed unrelated via an isolated, uncontended rerun
passing 10/10), zero regressions. Full-repo `pnpm build`/`pnpm lint` green
across all workspace tasks. `apps/portal`/`apps/admin` Playwright suites
untouched — this step has no UI surface.

## 5.2 — Table partitioning + archival

Phase 5's second slice (2026-09-14) — `packages/db`,
`apps/api/src/partitioning`, `apps/api/src/platform/partitioning`,
`packages/shared`. See
[`docs/conventions/partitioning-archival.md`](./conventions/partitioning-archival.md)
for the full write-up. Turns ON the native Postgres partitioning
`attendance_records` (1.3) and `audit_log` (0.9) were deliberately built
PARTITION-READY for since their own original steps (composite
`(id, <partition column>)` primary keys, chosen back then for exactly this
migration) — and additionally partitions `platform_audit_log` (4.1), which
its own doc comment had explicitly flagged for the same Phase 5.2 treatment.

**The conversion is additive, not a rebuild.** One hand-written migration,
`partition_high_growth_tables`: rename the existing table aside (plus its
PK/FK/index names, a real gotcha caught before committing to this design —
Postgres does not auto-rename a table's own constraints/indexes when the
table itself is renamed, so the new partitioned table would otherwise
collide with the old ones' still-existing names), recreate it as a native
`PARTITION BY RANGE` table with IDENTICAL columns/PK/FKs/indexes/RLS
policy/grants, bootstrap monthly partitions covering both the existing
data's own date range and a lookahead, copy every row across, drop the
renamed-aside original. Nothing about how any caller queries/writes these
tables changes — Prisma still addresses one unchanged table name per
model. Actually run against this environment's own `audit_log` (50
pre-existing rows) and `platform_audit_log` (1,616 pre-existing rows)
during development, both counts confirmed unchanged afterward; the
mechanism itself is additionally proven, repeatably, by replaying the exact
recipe against a disposable scratch table in
`packages/db/test/partitioning.spec.ts`.

**`signature_events` (3.5.3) was assessed and deliberately NOT
partitioned** — it was never built with a composite, partition-key-
inclusive PK (unlike the three tables above), and its growth is
structurally bounded very differently (a handful of events per signed
document, not one row per employee per day or per mutating action
system-wide) — a scale decision, not a safety one, documented directly on
the model.

**RLS + immutability hold identically on partitions — verified empirically
against real Postgres BEFORE committing to the design**, not assumed: a
policy declared on the partitioned PARENT applies transparently to every
partition when queried through it (the only way Prisma ever addresses
these tables); a GRANT on the parent does NOT propagate to a partition
addressed directly by name (so a partition is, if anything, MORE locked
down by default — there's no code path that would ever reach for one
directly); `audit_log`'s DB-level `REVOKE UPDATE, DELETE FROM hrm_app`
needs to be issued only ONCE, on the parent, and blocks mutation for every
row regardless of which month's partition it lives in — proven for both an
existing OLD partition and a freshly-bootstrapped FUTURE one.

**Automated partition management — no manual partition creation, ever.**
`hrm_ensure_range_partitions`, a reusable, idempotent `plpgsql` function
(the ONE place partition-creation DDL is expressed, called by both the
migration's own bootstrap and the runtime job below), explicitly
`REVOKE`d from `PUBLIC` on top of `hrm_app` structurally holding no
`CREATE` privilege at all. `PartitionMaintenanceService`
(`apps/api/src/partitioning`) is the SAME scheduled-BullMQ-orchestrator
shape every prior scheduled job in this codebase establishes — a daily job
keeps each managed table's partitions created from (current month - 1)
through (current month + that table's own configured `lookaheadMonths`),
plus a manual `POST /platform/partitioning/ensure` trigger. Proven
end to end: raising a table's lookahead and triggering `/ensure` creates a
partition 11 months out, and a REAL write to that far-future date
immediately succeeds afterward.

**Partition pruning proven, not assumed** — a real `EXPLAIN` on a
one-month time-range query, against `audit_log` seeded across several
months, mentions ONLY that month's partition in the plan, nothing else.

**Archival/retention** — `PartitionArchivalService`, the same scheduled-job
shape (monthly), plus a manual `POST /platform/partitioning/archive`
trigger: for each table with `archiveEnabled` (config in the new
`PartitionedTableConfig`, platform-wide, no RLS — same "platform catalog"
exemption `CountryPack` already establishes), finds partitions aged past
that table's `retentionMonths` and not yet archived, exports every row
FIRST (gzip JSONL, SHA-256 checksummed, uploaded via the SAME
`StorageService`/MinIO seam 1.1 established) and ONLY once that upload
durably succeeds does it detach + drop the partition + record an
`ArchivedPartition` row, all three atomically in one transaction — a failed
export never touches the hot table, and a mid-way failure after upload
rolls the detach/drop/record back together, never leaving a partition
"detached but unrecorded." Retrieval is a documented path: `GET
/platform/partitioning/archives` + `GET .../:id/download` (the same
`StreamableFile` pattern `payroll.controller.ts`'s bank-export/payslip
downloads already use). Proven that archiving one partition never disturbs
RLS/immutability for the data that remains in a DIFFERENT, non-aged
partition.

**The Phase 6.1 GDPR/data-residency seam, honestly scoped.**
`TenantRetentionOverride` (ordinary tenant-scoped table, RLS applies) lets
a tenant-specific retention preference be set/read/removed today via
`@PlatformRoute()` (`PARTITIONING_MANAGE`, dual-audited into both the
target tenant's own `audit_log` and `PlatformAuditLog` — the SAME shape
`PlatformTenantService.recordTenantAudit` already establishes) — but this
is stated plainly as SEAM PLUMBING, not a completed per-tenant purge:
`PartitionArchivalService`'s actual archival-eligibility decision reads
only the PLATFORM-WIDE default, because a single partition physically
holds every tenant's rows for that date range — there is no "archive this
partition for tenant A but not tenant B" without a genuinely different,
row-level purge mechanism, explicitly deferred to Phase 6.1.

Two new platform permissions (`PARTITIONING_READ`/`PARTITIONING_MANAGE`,
the SAME "READ broad (both roles), MANAGE narrow (owner-only)" split
`BILLING_READ`/`_MANAGE` and `BRANDING_READ`/`_MANAGE` already establish).

Scope discipline: RLS policies' own `USING`/`WITH CHECK` expressions,
`withTenantContext`'s mechanism, and every existing attendance/audit/
e-signature service's business logic are completely unmodified — this
step is a physical-storage change plus new, additive management/archival
machinery. Verified: `packages/db`'s full suite — **37 tests green** (28
existing + 9 new in `partitioning.spec.ts`), against real local Postgres.
`apps/api`'s full suite — **528 tests green** (521 existing + 7 new in
`partitioning.e2e-spec.ts`), zero regressions — every pre-existing
attendance/audit/e-signature spec file passes completely unmodified,
proving this step is transparent to every existing caller. A real bug
this step's OWN test run caught before it shipped: the migration's
initial partition-bootstrap window (current month ± a small margin) was
too narrow for this codebase's own existing fixed-date test fixtures
(`attendance.e2e-spec.ts` writes hardcoded 2026 dates like `2026-04-01`)
— "no partition of relation found for row" on a plain `INSERT`, a direct,
concrete illustration of exactly the failure mode this step's automated
partition-ahead-of-time job exists to prevent. Fixed by widening the
migration's bootstrap logic to always cover at least the whole current
calendar year through Q1 of the next one (in addition to whatever real
historical/future data requires), verified by resetting the local dev DB
from scratch and re-running the full suite clean. Full-repo `pnpm build`/
`pnpm lint` green across all 8 workspace tasks. `apps/portal`/`apps/admin`
untouched — this step is backend/infra-only, no UI surface (per this
step's own scope).
