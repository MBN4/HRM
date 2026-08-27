# Licensing / feature flags

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.6 — `packages/db`, `packages/shared`,
`apps/api/src/licensing`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"0.6 licensing / feature flags" entry) for the full file list and
verification notes.

- **Editions → flags.** `TenantEdition` (STARTER/PROFESSIONAL/ENTERPRISE,
  from 0.2) gates a set of feature flags via `packages/shared`'s
  `EDITION_FEATURES` — a pure code constant (product/pricing decision,
  not tenant-editable data, unlike RBAC's `PERMISSIONS`/
  `SYSTEM_ROLE_PERMISSIONS`, which are only DB-seed defaults — see
  [auth-rbac.md](./auth-rbac.md)). List every flag an edition should have
  explicitly rather than relying on inheritance — ENTERPRISE ⊇
  PROFESSIONAL ⊇ STARTER by convention, not by structure, so a deliberate
  exception is a one-line diff. The catalog (`FEATURE_FLAGS`) today:
  `advanced_reporting`, `custom_roles`, `api_access` (PROFESSIONAL+),
  `sso`, `multi_country_payroll`, `custom_workflows`,
  `audit_log_export` (ENTERPRISE only).
- **`@RequireFeature(...flags)` + `FeatureFlagGuard`.** Deny-by-default,
  identical shape to `@RequirePermissions()` + `PermissionsGuard`
  (applied via `@UseInterceptors()` despite the name, for the same
  "guards run before any interceptor, but this needs `tx`" reason — see
  [auth-rbac.md](./auth-rbac.md)). Unlike `PermissionsGuard`, it queries
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
  seam** (see [tenant-resolution.md](./tenant-resolution.md) → Platform
  (no-tenant) context). `LicensingAdminController`'s three routes
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
  emitting it from `FeatureFlagGuard`'s hot path would). This
  cross-tenant-via-owner-`prisma`-client pattern is reused by 0.7's
  workflow escalation sweep — see [workflow.md](./workflow.md) → The
  escalation sweep.
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
