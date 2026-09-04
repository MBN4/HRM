# Vendor super-admin console (platform auth · tenant lifecycle · packs · usage · impersonation)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 4.1 (Phase 4's first slice) — `packages/db`, `packages/shared`,
`apps/api/src/platform`, `apps/admin`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)
(the "4.1 vendor super-admin console" entry) for the full file list and
verification notes. This is the platform YOU (the vendor) operate to run
the whole business — cross-tenant by nature, the single most dangerous
surface in the system, and locked down accordingly. Builds directly on
[tenant-resolution.md](./tenant-resolution.md)'s `@PlatformRoute()` seam
(0.3), [licensing-feature-flags.md](./licensing-feature-flags.md)'s
license signing/feature-flag engine (0.6, reused unmodified),
[country-packs.md](./country-packs.md)'s pack schema/resolution engine
(0.5, reused unmodified), and [audit-custom-fields.md](./audit-custom-fields.md)'s
audit sink (0.9, extended).

## The gap this step closes

Through 0.6/0.10, `@PlatformRoute()` carried **no authenticated identity at
all** — `TenantScopeInterceptor` checked only the `PLATFORM_MODE_ENABLED`
env flag before letting a request through to `LicensingAdminController`/
`RateLimitAdminController`. Any caller who could reach the API at all could
issue/revoke a license or override a tenant's rate limit once that flag was
on. This was a deliberately scoped gap at the time (0.3's own doc comment:
"real RBAC- and audit-gated cross-tenant access is a later step") — this
step is that later step. **Every** `@PlatformRoute()` now requires a fully
authenticated, MFA-verified `PlatformAdmin` by default; the only exemption
is `@AllowAnonymousPlatform()`, reserved for the handful of routes that
themselves establish a platform session (login, MFA enroll/verify, refresh).
`LicensingAdminService`/`LicenseSigningService`/`CountryPackResolutionService`
are all **reused unmodified** — this step is authentication/authorization/
audit wrapped around existing engines, never a rebuild of them.

## 1. Platform identity — a separate space from tenant `User`

- **`PlatformAdmin`** (`schema.prisma`) is, like `Tenant`/`CountryPack`,
  deliberately **NOT tenant-scoped** (no `tenantId` column) and therefore
  **NOT subject to Row-Level Security** — a platform admin isn't a member
  of any tenant, the same exemption class `Tenant` itself documents. Unlike
  `CountryPack` (which grants `hrm_app` read access, since tenant requests
  resolve packs live), `hrm_app` is granted **nothing** on `platform_admins`
  — no tenant-scoped request path ever needs to read it. Every access goes
  through the owner `prisma` client on the audited `@PlatformRoute()` path
  only.
- **Structurally separate, not just a role flag**: a tenant `User` can
  never become a platform admin by any data path (different table, no FK
  between them), and a platform admin never appears in any tenant's own
  People screens. This is the literal implementation of "platform admins
  are a separate identity/role space, not a tenant role."
- **Two roles, code-level, not DB-editable.** `PlatformAdmin.role`
  (`PlatformRoleName`: `PLATFORM_OWNER` | `PLATFORM_SUPPORT`) is checked
  against `@hrm/shared`'s `PLATFORM_ROLE_PERMISSIONS` — a **pure code
  constant**, the same posture `EDITION_FEATURES` (0.6) documents for
  itself: the vendor's own ops-staff role model is a fixed, reviewed,
  two-role set, not tenant-customizable data the way tenant `Role`/
  `Permission` are. `PLATFORM_SUPPORT` holds `TENANT_READ`, `USAGE_READ`,
  `AUDIT_READ`, `IMPERSONATION_START` — it can look, and it can start a
  support impersonation session, but it cannot create/suspend/delete a
  tenant, issue a license, author a country pack, touch rate-limit
  overrides, or manage other platform admin accounts. `PLATFORM_OWNER`
  holds every permission in the catalog, including the two held back from
  `PLATFORM_SUPPORT` on purpose: `TENANT_DELETE` (deliberately a SEPARATE
  permission from `TENANT_MANAGE` — the single most destructive action in
  the catalog gets its own tightly-held permission) and `ADMIN_MANAGE`
  (managing OTHER platform admin accounts — a `PLATFORM_SUPPORT` admin can
  never create a peer or promote themselves).
- **`PlatformPermissionsGuard` + `@RequirePlatformPermissions(...)`** is
  the platform-context sibling of 0.4's `PermissionsGuard`, same
  interceptor-not-guard reasoning (the platform admin's role isn't known
  until `TenantScopeInterceptor`'s own interceptor-phase authentication has
  run — see [auth-rbac.md](./auth-rbac.md) for why this shape exists at
  all).

## 2. Mandatory MFA — a real state machine, not a checkbox

- **No code path issues a platform session token from a password alone.**
  `POST /platform/auth/login` (`PlatformAuthService.login`) verifies the
  password (reusing `PasswordService`, the SAME argon2id primitive 0.4
  uses for tenant users) and then branches on `PlatformAdmin.mfaEnabled`:
  - **Not yet enrolled** → returns `{ mfaSetupRequired: true,
enrollmentToken }` (a Redis-backed, 10-minute, single-use token —
    `platform:auth:enroll:<token>`). `POST /platform/auth/mfa/enroll`
    generates a fresh TOTP secret, stores it AES-256-GCM-encrypted
    (`EncryptionService`, reused as-is) against that SAME enrollment
    token (not yet persisted onto the `PlatformAdmin` row), and returns
    the secret + an `otpauth://` URI for the admin to scan.
    `POST /platform/auth/mfa/enroll/confirm` verifies a code against that
    pending secret, and ONLY on success persists `mfaSecretEncrypted` +
    `mfaEnabled: true` + a fresh set of one-time recovery codes
    (argon2id-hashed via `HashingService`, the same reversible-vs-hashed
    split [integrations.md](./integrations.md) documents for API keys vs.
    webhook secrets) — then issues a real session, the same as a normal
    login would.
  - **Already enrolled** → returns `{ mfaRequired: true, challengeToken }`
    (Redis-backed, 5-minute, single-use, `platform:auth:mfa-challenge:<token>`).
    `POST /platform/auth/mfa/verify` accepts either a 6-digit TOTP code
    (checked against the decrypted secret) or a one-time recovery code
    (argon2id-verified, then REMOVED from the stored array — each works
    exactly once); either path issues a real session on success.
- **TOTP implemented with only Node's built-in `crypto`**
  (`apps/api/src/platform/auth/totp.util.ts`, RFC 4226/6238) — the same
  "no extra dependency" posture 0.9's timezone rendering and 3.3's OIDC
  JWKS verification already take. A constant-time comparison
  (`timingSafeEqual`) per candidate code, ±1 time-step window for clock
  drift.
- **Re-checked on every request, not just at login.** `PlatformAuthContextService.authenticate`
  (the interceptor-facing lookup) verifies `admin.mfaEnabled` is still
  true on every single `@PlatformRoute()` call — an admin whose MFA was
  somehow disabled (a future admin-assisted reset, direct DB
  intervention) loses platform access immediately, not just at their next
  login.
- **Rate-limited independently at both factors** — `platform-login:<email>`
  (5/15min, reset on password success) and `platform-mfa:<adminId>`
  (8/15min, reset on MFA success) — the SAME `RateLimiterService` fixed-
  window primitive 0.4/0.10 already established, applied twice, the
  project's consistent "no single layer trusted alone" posture.

## 3. Platform tokens — structurally separate from tenant tokens

- **`PlatformTokenService`** (`apps/api/src/platform/auth/`) signs/verifies
  with `PLATFORM_JWT_SECRET` — a **separate secret** from tenant auth's
  `JWT_SECRET`, via its own `JwtService` instance. This is a structural
  guarantee, not a convention: a tenant user's access token can never
  verify as a platform token (or vice versa) no matter what claims get
  crafted into it, because the two token families don't share a signing
  key — the same class of "separate signing surface for the most
  sensitive credential" decision 0.6 makes for license files (a dedicated
  RS256 keypair). Refresh rotation + reuse detection mirrors 0.4's
  `TokenService` exactly (family tracking, a rotated-away token kept as a
  tombstone, reuse revokes the whole family) but keyed by `platformAdminId`
  alone — deliberately a small, separate implementation rather than
  generalizing `TokenService` to accept an optional tenant dimension,
  which would blur a security-relevant type distinction for a few dozen
  lines of reuse.
- **`PlatformAuthContextModule`** is a small LEAF module (mirrors 3.3's
  `ApiKeyAuthModule` exactly) imported by `TenancyModule` so
  `TenantScopeInterceptor` can authenticate a `@PlatformRoute()` request —
  deliberately NOT the same module as the bigger `PlatformModule`
  (login/MFA/tenant-lifecycle/... controllers), which needs a WORKING
  interceptor already wired.

## 4. Cross-tenant access — the owner-`prisma`-client pattern, extended

Every platform service in this step (`PlatformTenantService`,
`PlatformCountryPackService`, `PlatformUsageService`,
`PlatformImpersonationService`, `PlatformAuditQueryService`,
`PlatformAdminService`) queries through the owner `prisma` client
directly — the SAME "a platform request opens no tenant-scoped
transaction" reasoning `LicensingAdminService` (0.6) already established
(see [tenant-resolution.md](./tenant-resolution.md) → Platform context).
`FORCE ROW LEVEL SECURITY` on every tenant-scoped table means this is
structurally the ONLY way to cross a tenant boundary — no normal tenant
request gains anything from these services existing, regardless of how
many more of them accumulate over time.

## 5. Tenant lifecycle

`PlatformTenantController`/`PlatformTenantService`
(`platform/tenants/`) — create / suspend / resume / update (edition,
hosting region, provision mode) / delete, plus a lightweight user list
for the impersonation picker.

- **`TenantProvisionMode`** (`SHARED_DB` | `DB_PER_TENANT`, new
  `Tenant.provisionMode` column, defaulted `SHARED_DB`) is a **documented
  SEAM ONLY**, per this step's own brief ("a documented seam, not a full
  build now") — nothing in `withTenantContext`/RLS/the connection pool
  reads this value; it exists so a future DB-per-tenant provisioning
  pipeline has somewhere to read the operator's intent from.
- **Create seeds real RBAC** — `seedSystemRolesAndPermissions` (0.4's
  own sanctioned provisioning function, its doc comment literally says
  "this is also the function real tenant provisioning should call for
  every new tenant") — a freshly created tenant is immediately usable,
  never an empty shell with no roles. An initial `TENANT_ADMIN` `User` is
  OPTIONAL (`initialAdminEmail`/`initialAdminName`/`initialAdminPassword`,
  all-or-nothing via a `.refine()`) — creating a tenant with none is a
  legitimate vendor operation (pre-provisioning ahead of a customer's own
  onboarding flow), not an error state.
- **`TENANT_STATUS` is now actually enforced** — flagged as deliberately
  NOT checked back in 0.3/0.6 ("that's a licensing/billing concern for a
  later step"). `TenantScopeInterceptor` now rejects (`403`) EVERY request
  for a `SUSPENDED`/`CANCELLED` tenant — checked immediately after tenant
  resolution, BEFORE rate limiting or the DB transaction even opens, for
  BOTH the JWT/subdomain path and the API-key path. This blocks the LOGIN
  route too (it's an ordinary `@AllowAnonymous()` route, not `@Public()`,
  so it still goes through tenant resolution) — "a suspended tenant's
  users are blocked" means genuinely blocked, not just unable to get a
  NEW token.
- **Delete is a genuine, irreversible hard delete** — every relation in
  `schema.prisma` cascades from `Tenant`, so this removes every row the
  tenant ever owned. Gated by `confirmSlug` matching the tenant's own slug
  EXACTLY (type-to-confirm, the UI enforces it as a disabled submit button
  until the typed value matches) on top of `TENANT_DELETE` — the tenant's
  own `audit_log` is about to be cascaded away with everything else, so
  the deletion itself is recorded into the PLATFORM's own audit trail
  (which survives it), not the tenant's.

## 6. Country Pack authoring/versioning — the saleable-asset workshop

`PlatformCountryPackController`/`PlatformCountryPackService`
(`platform/country-packs/`) — this is CRUD/lifecycle around the
EXISTING 0.5 pack schema (`@hrm/shared`'s `countryPackConfigSchema`) and
resolution engine, reused as-is; nothing about
`CountryPackResolutionService` or the rules engine changed.

- **Create** activates immediately as version 1 (no existing active config
  to clobber for a brand-new country). **`createVersion`** always starts a
  new DRAFT (`isActive: false`), defaulting its config to a clone of the
  currently active version unless a fresh one is supplied — the
  "author, then activate" workflow this step's brief calls for.
- **Edit is DRAFT-only** — `updateVersion` rejects (`400`) an attempt to
  edit an `isActive: true` row in place; the only way to change an active
  pack's behavior is to draft a new version and activate it, which keeps
  the "versioned, immutable published config" property 0.5 already
  established for tenants' own resolution.
- **"Well-formed before activation" is enforced TWICE** — `countryPackConfigSchema`
  already validates on every write via the route's `ZodValidationPipe`
  (create/createVersion/updateVersion all `400` on a malformed payload),
  AND `activate` re-validates (`safeParse`) the STORED row again before
  flipping it live — defense-in-depth against a config that somehow
  reached the DB malformed (proven in the e2e suite by writing a
  malformed row directly via `prisma.countryPack.create`, bypassing the
  API entirely, and confirming activation still refuses it).
- Activation is one transaction: every OTHER version for that country
  flips `isActive: false`, this one flips `true`.

## 7. Usage metrics — cheap reads only, never a live heavy scan

`PlatformUsageController`/`PlatformUsageService` (`platform/usage/`) —
per this step's own brief: "read from existing data / rollups; don't
live-aggregate heavy tables."

- **Seats**: `Employee.count({ status: 'ACTIVE' })` against the tenant's
  active `License.seatCap` (lifetime mode) falling back to
  `Subscription.seatCap` (SaaS mode) — an indexed `COUNT`, the same class
  of cheap query `SeatCapService` (0.6) already runs at request time for
  its own enforcement, never a full scan.
- **Storage**: `EmployeeDocument.aggregate` (`_count`, `_sum(sizeBytes)`)
  — the only place a file size is tracked today. **Honest gap**: object
  storage usage isn't accounted anywhere else in this system (payslip
  PDFs, checklist uploads, ...) — a real storage-accounting pass is future
  work, not attempted here.
- **API volume**: reads the LIVE Redis fixed-window counter
  `TenantRateLimitService.enforce` already increments on every request
  (`TenantRateLimitService.getCurrentWindowUsage`, new, additive) — zero
  extra cost, but a SNAPSHOT of the current window only. **Honest gap**:
  there is no persisted, historical request-volume ROLLUP in this system
  (unlike headcount/attendance/leave, which 1.5 already precomputes daily)
  — worth building the same way alongside 4.2's real billing integration,
  which is the first consumer that actually needs a trend, not a snapshot.
- **Platform-wide overview** (`GET /platform/usage/overview`): `Tenant.groupBy`
  on `status`/`edition` (indexed columns), plus two more cheap counts — never
  a per-tenant loop.

## 8. Impersonation — designed very carefully, per this step's own brief

`PlatformImpersonationController`/`PlatformImpersonationService`
(`platform/impersonation/`).

- **(a) Permission-gated.** `POST /platform/impersonation/tenants/:tenantId/sessions`
  requires `IMPERSONATION_START` (both roles hold it — this is the one
  cross-tenant capability PLATFORM_SUPPORT genuinely needs for its job).
  Refuses a SUSPENDED/CANCELLED target tenant and a non-`ACTIVE` target
  user (`403` either way) — impersonation never bypasses the same
  liveness checks an ordinary login would face.
- **(b) Time-boxed, and the SESSION ROW is the source of truth, not just
  the token's `exp`.** `ImpersonationSession` (tenant-scoped — it targets
  a real tenant `User` — ordinary RLS, `@@unique([tenantId, id])`) records
  `startedAt`/`expiresAt`/`reason`/`platformAdminId`/`targetUserId`.
  Duration is capped SERVER-SIDE at `MAX_IMPERSONATION_MINUTES = 60`
  regardless of what's requested (the zod schema's own 120-minute max is
  a looser upper bound; the service enforces the real, tighter one) — a
  session that could be silently extended forever isn't actually
  time-boxed. The minted access token
  (`TokenService.signImpersonationAccessToken`, an ADDITIVE method on the
  EXISTING 0.4 `TokenService` — same `JWT_SECRET`, same verification path
  every ordinary tenant token already goes through) carries
  `impersonatedBy`/`impersonationSessionId` claims on top of the ordinary
  `{sub, tenantId}` shape, with `exp` set to match the session's own
  remaining lifetime. **Deliberately no refresh token is issued alongside
  it** — when the token lapses, the platform admin must explicitly start
  a NEW, separately-audited session rather than silently riding one out
  indefinitely.
  `TenantScopeInterceptor.authenticate()` — on EVERY request authenticated
  with such a token — re-validates the LIVE `ImpersonationSession` row
  (exists, targets this exact user, not `endedAt`, `expiresAt` still in
  the future) INSIDE the tenant's own RLS-scoped transaction, not just
  trusting the JWT's own `exp`. Proven in the e2e suite by externally
  back-dating a session's `expiresAt` via direct DB write and confirming
  the still-unexpired-by-JWT-standards token immediately stops
  authenticating.
- **(c) LOUDLY audited, (d) never silent.** Session start/end are recorded
  into BOTH the platform's own `PlatformAuditRecordService` (the vendor's
  consolidated cross-tenant trail) AND — via the EXISTING
  `AuditRecordService.recordForTenant`, `actorPlatform: true`, the SAME
  convention 0.6's `LicensingAdminService` already established — the
  TARGET TENANT'S OWN `audit_log`. This is "never silent" made concrete:
  a tenant's own `TENANT_ADMIN`, using their perfectly ordinary `GET
/audit` (`audit.read`), can see for themselves that they were
  impersonated, by whom, and why — they are not merely told it's audited
  somewhere they can't see. Every OTHER action taken WHILE impersonating
  is tagged too: `AuditInterceptor` (0.9) now includes
  `impersonatedByPlatformAdminId` (read from
  `TenantContextService.impersonatedByPlatformAdminId`, a new field on
  `RequestTenantStore` populated only for a request authenticated via an
  impersonation token) in every captured mutation's `metadata` — so a
  tenant reviewing "who changed X" sees the REAL platform admin's id
  right alongside the impersonated user's id as `actorUserId`, never just
  the latter.
- **Ending your own session vs. revoking someone else's are different,
  differently-gated operations.** `POST .../sessions/:id/end` requires
  only `IMPERSONATION_START` but the SERVICE itself refuses to end a
  session unless the caller is the session's own `platformAdminId`.
  `POST .../sessions/:id/revoke` requires the separate, higher-bar
  `ADMIN_MANAGE` (PLATFORM_OWNER-only) and bypasses the ownership check —
  a deliberate two-tier design: any admin can always end their OWN
  session, but forcibly ending ANOTHER admin's active session is an
  owner-level intervention.
- **Known, documented scope boundary**: this step builds the BACKEND
  primitive (a working impersonation access token any tenant-scoped route
  accepts, proven end-to-end against a real route) and the admin
  console's own controls (start/end/revoke/history, a copyable token).
  Automatically CONSUMING that token inside `apps/portal` (auto-detecting
  and applying it in the tenant portal's own browser session) is
  explicitly OUT of this step's scope — the task's own file list names
  `apps/api`/`packages/db`/`packages/shared`/`apps/admin` only, not
  `apps/portal`. A support engineer pastes the issued token manually
  today; wiring the portal to accept one automatically is a natural,
  narrow follow-up whenever it's prioritized.

## 9. Cross-tenant audit read

`PlatformAuditController`/`PlatformAuditQueryService` (`platform/audit/`)
— gated on `AUDIT_READ` (both roles hold it). Two read paths:

- **`GET /platform/audit`** — the platform's OWN `PlatformAuditLog` (the
  no-single-tenant-target trail: country-pack authoring, cross-tenant
  listings, platform-admin account management, and — per this step's
  brief calling out "cross-tenant reads... especially" — every
  cross-tenant read this controller itself serves).
- **`GET /platform/audit/tenant/:tenantId`** — a SPECIFIC tenant's own
  `audit_log`, read cross-tenant via the owner `prisma` client (the same
  pattern § 4 describes) — this is the "access to the audit trail across
  tenants" capability named directly in this step's brief.
- **Every read through EITHER path is itself recorded into
  `PlatformAuditLog`** (`platform.audit.platform_log_read` /
  `platform.audit.tenant_log_read`, including the filters used) — reading
  the audit trail is itself an audited action, not exempt from the rule
  it enforces on everything else.

`PlatformAuditLog` (schema.prisma) is, like `PlatformAdmin`, NOT
tenant-scoped and NOT subject to RLS, for the same reason. PARTITION-READY
shape (composite `(id, occurredAt)` PK), the same reasoning `AuditLog`
(0.9) already documents for itself — this table is append-only and
unbounded too, though the actual `PARTITION BY RANGE` migration remains
Phase 5.2 for both.

## 10. `apps/admin` — the console UI

A distinct visual identity on purpose (indigo/slate `tailwind.config.ts`
tokens vs. `apps/portal`'s teal/sand) — this step's own brief calls for
the security affordances to be "crystal clear," and giving the vendor
console an unmistakably different look is part of that: nobody should
mistake a screenshot of it for the tenant portal. Reuses `apps/portal`'s
`components/ui/*` shapes near-verbatim (same token NAMES, different hex
values) and the identical `I18nProvider`/`useAsync` patterns 0.9/1.4
established — **functional over fancy**, consistent with this being
internal tooling for vendor ops staff, not a tenant-facing product
surface: new UI copy is plain English inline rather than grown through
`@hrm/shared`'s `UI_MESSAGES` catalog (a deliberate scope decision, not an
oversight — that catalog exists for `apps/portal`'s session-aware i18n,
which this console has no tenant session to resolve a locale from
anyway).

- **`lib/auth/PlatformAuthContext.tsx`** is a LARGER state machine than
  `apps/portal`'s own `AuthContext` (a single `login()` call) —
  necessarily: platform login is password THEN mandatory MFA, so the
  context exposes `loginWithPassword`/`startMfaEnrollment`/
  `confirmMfaEnrollment`/`verifyMfa` as distinct steps; nothing ever
  populates a real session (`me`) without both factors succeeding.
  `lib/auth/token-storage.ts` uses ITS OWN localStorage key
  (`hrm-admin.platformRefreshToken`, distinct from the portal's
  `hrm.refreshToken`) so the two apps' sessions can never collide even in
  the same browser profile.
- **The "who am I / am I MFA-verified" affordance is always visible**
  (`components/layout/Topbar.tsx`) — a green shield + the caller's role
  badge on every authenticated screen. There is no way to be signed in to
  this console without MFA, so this is never a guess.
- **RBAC hides the action, it doesn't just block it** — the same posture
  `apps/portal`'s own admin console (2.4) already takes: a
  `PLATFORM_SUPPORT` session never renders the "New tenant"/"Suspend"/
  "Delete"/"New country" buttons, and the "Platform admins" nav item
  doesn't exist for it at all (the `/admins` PAGE itself still renders an
  explicit "restricted to PLATFORM_OWNER" message if navigated to
  directly, rather than a raw 403 — the backend is still the real
  enforcement either way).
- **Impersonation UI** (on a tenant's detail page): pick a target user
  (only `ACTIVE` ones selectable), a required reason, a duration — on
  success, shows the resulting access token with a copy button and a
  loud, non-dismissable-looking red warning banner naming exactly what's
  happening and when it expires. A dedicated `/impersonation` page lists
  EVERY session across every tenant (active-only filter), with
  End/Revoke actions gated exactly per § 8's ownership rule.
- **Country pack config editing is a raw JSON textarea**, not a 30-field
  generated form — client-side `JSON.parse` before submit, server-side
  `countryPackConfigSchema` validation either way. A deliberate
  "functional over fancy" choice for an authoring surface used by a
  handful of vendor ops staff, not a tenant-facing form.

## 11. Testing

Real infra, no mocks — the same posture every prior phase's suite already
takes.

- **Backend**: five new `apps/api/test/platform-*.e2e-spec.ts` files (41
  new tests) covering the full MFA state machine (setup, verify, wrong
  password/code, recovery-code single-use, refresh rotation + reuse
  detection, a suspended admin's token dying immediately), THE CRITICAL
  boundary (a valid TENANT token — and no token at all — rejected on
  every platform route), least-privilege (PLATFORM_SUPPORT denied every
  owner-only action), tenant lifecycle (create with/without an initial
  admin, duplicate-slug rejection, suspend blocking EVERY request
  including login itself, resume restoring it, delete's confirm-by-slug
  gate), usage metrics correctness, country-pack authoring/versioning/
  activation (including the malformed-row-bypassing-the-API proof), and
  impersonation (works end-to-end against a real tenant route, the
  duration cap, the session-row-is-source-of-truth expiry proof, the
  audit tagging proof, the end-vs-revoke ownership boundary, and
  cross-tenant audit read being itself logged). Four EXISTING e2e files
  (`licensing-saas`, `licensing-lifetime`, `resilience`, `audit`) were
  updated to authenticate as a platform admin — they previously called
  `/platform/*` routes with no token at all, which is exactly the gap
  this step closes; `licensing-saas.e2e-spec.ts` also gained two new
  assertions proving the no-token and wrong-token-family cases 401.
  `apps/api`'s full suite: **423 tests green** (382 existing/boundary +
  41 new).
- **`apps/admin`**: a NEW `playwright.config.ts`/`tests/` suite (three
  spec files) — `auth.spec.ts` drives the REAL enrollment UI end-to-end
  (reading the on-screen TOTP secret, computing a real code with a
  test-local RFC-6238 implementation, confirming, seeing recovery codes
  exactly once), `tenants.spec.ts` (create/suspend/resume/edit/delete
  through the real UI, impersonation start/end and its audit-trail
  visibility), `rbac-and-country-packs.spec.ts` (PLATFORM_SUPPORT's
  hidden actions + restricted `/admins` page, country-pack authoring
  through the real UI). `tests/crypto-helpers.ts` is a small, deliberate,
  test-local duplicate of the backend's AES-256-GCM/TOTP algorithms (a
  separate Playwright process has no access to `apps/api`'s `src` tree)
  — any drift from the real implementation shows up immediately as a
  failing login in every spec but `auth.spec.ts`.

## Known, documented gaps for this phase

`TenantProvisionMode.DB_PER_TENANT` is a schema/UI seam only — no real
per-tenant database provisioning pipeline exists yet, per this step's own
scoped brief. Usage metrics' API-volume figure is a live snapshot, not a
historical rollup (no persisted time-series exists for request volume
today — see § 7). Impersonation issues a working access token but nothing
in `apps/portal` auto-consumes it yet (see § 8's closing note) — a support
engineer pastes it in manually. `AuditInterceptor`'s
`impersonatedByPlatformAdminId` tagging covers the HTTP-mutation capture
path only; domain-event-sourced audit entries (`DomainEventAuditListener`)
do not currently carry the impersonation tag, since domain events don't
carry actor context beyond their own payload — a real, honestly-labeled
gap, not a silent omission. Real SaaS billing (Stripe) landed in step 4.2
— see [billing.md](./billing.md) — and is now the real consumer of this
step's usage metrics/seat-count primitives it was flagged for; the
vendor console itself gained a cross-tenant `/billing` overview and a
per-tenant billing card as part of that step. White-labeling landed in
step 4.3 — see [white-label.md](./white-label.md) — and reuses this
step's own dual-audit pattern (`AuditRecordService.recordForTenant` +
`PlatformAuditRecordService`) for its own branding/domain oversight
actions; the vendor console gained a cross-tenant `/branding` overview
and a per-tenant branding card as part of that step.
