# Security hardening, accessibility (WCAG), and backups/DR

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 6.2 (Phase 6's second slice) — `apps/api/src/security`,
`apps/api/src/common/encryption/key-provider`, `apps/api/src/auth/mfa`,
`.github/workflows/ci.yml`, `apps/portal/tests`, `apps/admin/tests`,
`ops/backup/`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "6.2" entry)
for the full file list and verification notes. This step's own brief was a
HARDENING + RE-VERIFICATION pass across three genuinely different areas —
it does not introduce new business functionality, and per its own
constraint it never weakens an existing control anywhere in the codebase.

## 1. Security hardening

### 1.1 Secure headers + CORS

`apps/api/src/main.ts` previously called `app.enableCors()` with **no
options at all** — any origin, no allow-list — and installed no secure-
headers middleware. `configureSecurity(app)`
(`apps/api/src/security/configure-security.ts`, factored out of `main.ts`
the exact way `setupSwagger` already was, specifically so the e2e suite can
exercise the identical wiring against its own `TestingModule`-built app)
now applies both:

- **`helmet`** — HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options`,
  and a real Content-Security-Policy (`default-src 'self'`). CSP is TUNED,
  not left at helmet's strict default: `swagger-ui-express` (mounted at
  `/v1/docs` by `setupSwagger`, step 3.3) serves an HTML page with an
  inline bootstrap `<script>`/`<style>`, so `script-src`/`style-src` carry
  `'unsafe-inline'` — a documented, narrow relaxation for that one page
  rather than a blanket CSP bypass. TLS itself is terminated at the load
  balancer/ingress in every real deployment (see
  [deployment-scaling.md](./deployment-scaling.md) → `deploy/k8s/`), never
  inside this process — HSTS is still set here since it's a response
  header, not a listener option.
- **`CorsOriginService`** (`apps/api/src/security/cors-origin.service.ts`)
  — a real allow-list mirroring `TenantResolutionService`'s own strategies
  (step 0.3/4.3) on purpose: an origin is allowed exactly when a browser
  tab at that origin could ALSO resolve a tenant here. Three sources,
  checked in order: `TENANT_BASE_DOMAIN` and its subdomains (the same
  suffix match `resolveBySubdomain` uses); an explicit
  `CORS_ADDITIONAL_ORIGINS` env allow-list (full origins, comma-separated —
  local dev ports, or a deployment's own first-party web origins that
  don't live under `TENANT_BASE_DOMAIN`); a tenant's **VERIFIED** custom
  domain (step 4.3) — the identical `verificationStatus === 'VERIFIED'`
  gate `resolveByCustomDomain` already enforces, so an unverified/pending
  domain can't grant itself CORS access any more than it can hijack tenant
  resolution traffic. Verified-domain lookups are cached in Redis for 30s
  (same bounded-staleness tradeoff `TenantRateLimitService` already
  documents for itself) to keep the hot path to one Redis round trip. No
  `Origin` header at all (server-to-server, curl, the mobile app's native
  HTTP stack) is always allowed — CORS is a browser-enforced concept only.
  `credentials: true` since portal/admin/mobile all send `Authorization`
  headers from a browser context.

Verified end to end by `apps/api/test/security-headers-cors.e2e-spec.ts`
(6 tests: every helmet header actually present; a subdomain origin, an
explicit allow-list entry, and a VERIFIED custom domain all get
`Access-Control-Allow-Origin` echoed back; an UNVERIFIED custom domain and
an unrelated origin both get no CORS header at all).

### 1.2 Field-encryption key rotation + the secrets-provider seam

`EncryptionService` (step 1.1, AES-256-GCM) previously read a single
`FIELD_ENCRYPTION_KEY` straight from `ConfigService` at construction — no
rotation story, no secrets-manager seam. Two additive changes, both fully
backward-compatible with every value already encrypted in the database
(Employee bank details/compensation per [employee.md](./employee.md), MFA
secrets below):

- **Key rotation.** New ciphertext is version-prefixed:
  `v<version>:<iv>:<authTag>:<data>`. `decrypt()` reads the prefix and
  looks up the matching key from a `version -> key` map the provider
  returns; ciphertext with **no** prefix — every value encrypted before
  this step existed — is treated as the implicit version `"1"`. Rotating
  `FIELD_ENCRYPTION_KEY` means: move the retiring key into
  `FIELD_ENCRYPTION_PREVIOUS_KEYS` as `<old version>:<old base64 key>`,
  generate a fresh `FIELD_ENCRYPTION_KEY`, and bump
  `FIELD_ENCRYPTION_KEY_VERSION` — every already-encrypted value (prefixed
  or legacy-unprefixed) keeps decrypting correctly with zero migration;
  `encrypt()` immediately starts writing under the new version. Proven by
  `apps/api/src/common/encryption/encryption.service.spec.ts` (10 tests:
  round trip, tamper detection via the GCM auth tag unchanged, legacy
  unprefixed ciphertext still decrypting, a full rotate-then-decrypt-old-
  and-new proof, and a clear error — never silent corruption — when a
  version's key genuinely isn't available).
- **The secrets-provider seam.** `EncryptionService` now depends on the
  `ENCRYPTION_KEY_PROVIDER` DI token
  (`apps/api/src/common/encryption/key-provider/encryption-key-provider.interface.ts`),
  not `ConfigService` directly — the SAME Symbol-token +
  `{provide, useFactory}` shape `STRIPE_CLIENT` (billing.md) and
  `CERT_PROVIDER` (white-label.md) already establish. `EnvSecretsProvider`
  (reads the env vars above) is the default binding; `CloudSecretsProvider`
  — a documented `NotImplementedException` seam, the exact posture
  `AcmeCertProvider` already takes for real ACME issuance — is bound
  instead whenever `SECRETS_PROVIDER` names a real cloud secrets manager
  (`aws-secrets-manager`/`vault`, never set in this repo). A real
  integration means writing one class that fetches key material from AWS
  Secrets Manager/Vault and returns the same `EncryptionKeySet` shape;
  `EncryptionService` needs no change either way.

**Encryption-at-rest coverage re-checked against employee.md's own claims**:
`Employee.baseSalaryEncrypted`/bank-detail fields are the only columns this
codebase encrypts at the application layer, unchanged by this step (still
correct — no new PII-adjacent column was added this step that should have
been but wasn't). **Encryption-in-transit**: TLS termination is normally at
the load balancer/ingress, honestly documented rather than faked in-app —
this process itself speaks plain HTTP, same posture `deployment-scaling.md`
already takes for its own `deploy/k8s/` ingress convention.

**No secrets leak into logs** — re-checked against
[observability-load.md](./observability-load.md)'s existing redaction: the
Pino structured logger and the 0.9 audit-redaction function
(`redactSensitiveFields`) already strip password/token/secret-shaped
fields generically; MFA secrets/recovery codes never appear in a logged
object shape in the first place (they're returned once, directly, in a
response body — never assigned to a field name redaction would need to
match). No new gap found here; no new test needed beyond the existing
redaction suite.

### 1.3 Optional tenant-user MFA

Platform admins have had MANDATORY TOTP MFA since step 4.1
(`PlatformMfaService`, `apps/api/src/platform/auth/totp.util.ts` — a
dependency-free RFC 4226/6238 implementation). Tenant users had none. This
step adds **OPTIONAL** MFA for tenant `User` accounts, reusing
`totp.util.ts` DIRECTLY (no otplib/speakeasy, no second TOTP algorithm) via
a new `TenantMfaService` (`apps/api/src/auth/mfa/tenant-mfa.service.ts`) —
the same shape as `PlatformMfaService`, applied to a separate identity
space, the same "platform vs. tenant get their own auth service even
though they share primitives" split `AuthService`/`PlatformAuthService`
and `TokenService`/`PlatformTokenService` already establish.

`User` gains three columns — `mfaSecretEncrypted`/`mfaEnabled`/
`mfaRecoveryCodesHashed` — the EXACT shape `PlatformAdmin` already carries
(secret AES-256-GCM encrypted via `EncryptionService`, since a fresh code
must be verified against it every login; recovery codes argon2id-hashed
via `HashingService`, one-way, each removed from the array the moment it's
used). "Optional" is enforced in `AuthService`, not a DB constraint — a
fresh user simply has `mfaEnabled=false` and logs in with a password
alone.

- `POST /auth/mfa/enroll` (authenticated) / `POST /auth/mfa/enroll/confirm`
  — starts/confirms enrollment for the CALLER's own account; confirming
  returns 10 one-time recovery codes, shown once.
- `AuthService.login` now branches once `user.mfaEnabled` is true: instead
  of tokens, it returns `{ mfaRequired: true, challengeToken }` (a Redis
  record, 5-minute TTL, the same shape `PlatformAuthService`'s own
  challenge already uses) — `POST /auth/mfa/verify`
  (`@AllowAnonymous()`, the caller has no session yet) accepts either a
  6-digit TOTP code or a one-time recovery code and, on success, issues a
  real session. Rate-limited separately from the password step
  (`mfa:<tenantId>:<userId>`, 8/15min via the existing `RateLimiterService`
  fixed-window primitive — no new algorithm).
- `POST /auth/mfa/disable` requires BOTH the current password AND a valid
  code — a hijacked session (a valid access token, no password) alone
  cannot silently turn MFA off — and revokes every other live refresh
  session, the same posture `changePassword` already takes.
- A challenge token is tenant-scoped by construction (the Redis key
  includes `tenantId`) — presenting one minted under tenant A's Host
  header never validates under tenant B's.

Every step emits a structured `auth.mfa_*` domain event (mirroring
`auth-events.ts`'s existing `auth.*` contract), automatically picked up by
`DomainEventAuditListener`'s existing `@OnEvent('auth.*')` wildcard — zero
audit-plumbing change needed.

Verified end to end by `apps/api/test/tenant-mfa.e2e-spec.ts` (13 tests:
enroll -> wrong code rejected/doesn't enable -> correct code enables +
returns recovery codes; login returns a challenge once enabled, not
tokens; wrong TOTP rejected; a challenge token is tenant-scoped (fails
under a different tenant's Host); correct TOTP issues a real session; a
challenge token is single-use; a recovery code is single-use; the MFA
verify rate limit fires; disable requires both factors and revokes every
other session).

**Deliberately scoped out**: no portal (`apps/portal`) enrollment UI was
built this step — the admin console already has a full platform-MFA UI
(step 4.1) to model one on later, but adding a SECOND UI surface for the
tenant-optional flow was judged disproportionate to this step's own
"keep it proportionate, don't over-build" instruction. The backend seam
is complete and tested; a tenant currently enrolls via direct API calls
(e.g. from a future portal "Security" settings page, or a script).

### 1.4 Auth surface re-verification

- **Refresh rotation + reuse detection** (`TokenService.rotate`) —
  re-read fresh this step, unchanged, still correct: a rotated-away token
  is tombstoned (`used: true`, kept until its original TTL), reuse revokes
  the entire family and emits `auth.refresh_reuse_detected`. Already
  covered by `auth-rbac.e2e-spec.ts`'s "rotates on refresh, then detects
  reuse" test — re-run clean this step (18/18 passing), no gap found.
- **Rate limiting on auth endpoints** — login/refresh/password-reset were
  already Redis-rate-limited per `{tenantId, email}` (step 0.4); MFA verify
  is now rate-limited too (§1.3). No unprotected auth route found.
- **Generic, non-enumerating errors** — login/refresh/reset already return
  the identical message regardless of _why_ (unknown email, wrong
  password, inactive account) — re-confirmed unchanged.

### 1.5 Input/output validation, raw SQL

- **Validation** — this codebase's ONE validation paradigm is zod schemas
  from `packages/shared` through `ZodValidationPipe` end to end (see
  [auth-rbac.md](./auth-rbac.md) → Security baseline) — a spot-check
  across employees/leave/payroll/benefits/e-signature/statutory-reporting
  controllers confirms every mutating route still validates its body this
  way; no `class-validator` (a second paradigm) anywhere, no unvalidated
  `@Body()` found.
- **Raw SQL** — `grep -rn '\$queryRawUnsafe\|\$executeRawUnsafe'` across
  `apps/api/src` and `packages/db/src` returns ZERO matches. Every
  `$queryRaw`/`$executeRaw` call in the codebase uses Prisma's tagged-
  template form (parameterized, injection-safe by construction) —
  confirmed by grep, not assumed.
- **CSRF** — this API is a pure JSON REST API authenticated via a
  `Authorization: Bearer` header (JWT) or an `X-Api-Key` header, NEVER a
  cookie — classic CSRF (a browser silently attaching a cookie to a
  cross-site form POST) does not apply to this auth model. The CORS
  allow-list (§1.1) is the actual relevant browser-origin control here.

### 1.6 API surface re-verification (integrations, step 3.3)

Re-read fresh this step against [integrations.md](./integrations.md):

- **API keys** — `ApiKeyAuthService.validate` looks up candidates by a
  12-char prefix (per-tenant, not globally unique) then verifies each
  candidate's FULL key via `HashingService.verify` (argon2id) — a
  same-prefix key belonging to a different tenant simply fails
  verification, never silently authenticates as the wrong tenant. Scopes
  are checked per-route; a SECOND, independent rate limiter
  (`ApiKeyRateLimitService`) runs alongside the per-tenant one. No gap
  found.
- **Webhook signing** — HMAC-signed deliveries, breaker-wrapped, unchanged;
  not re-touched this step beyond a fresh read.
- **SSO** — `AuthService` depends on the `AUTH_PROVIDER` token, never a
  concrete provider; the OIDC/SAML seam (step 3.3) provisions/logs in a
  user strictly WITHIN the tenant the request already resolved to (host/
  subdomain) — an SSO assertion cannot name or escalate into a different
  tenant, since `tenantId` is never taken from assertion claims, only from
  the already-resolved request context. No privilege-escalation or
  tenant-scope-bypass path found.

### 1.7 Abuse protection on anonymous/public surfaces

Every request — including every `@AllowAnonymous()` route — passes through
`TenantScopeInterceptor`'s per-tenant rate limit BEFORE the DB transaction
even opens (see [resilience.md](./resilience.md) → "THE SPINE IS ONE
INTERCEPTOR", step 5 of its documented order). `@AllowAnonymous()` only
skips the JWT check, never tenant resolution or rate limiting — so the
public careers API (`recruitment/careers`), the external e-signature
signing links (`esignature/external-signing.controller.ts`), and the MFA
verify/login/refresh routes are ALL already covered by the SAME per-tenant
fixed-window limiter, re-confirmed by re-reading each controller's
decorators this step (all `@AllowAnonymous()`, none `@Public()`, which
WOULD skip rate limiting — no route was found using `@Public()` where
`@AllowAnonymous()` was actually intended). The versioned public `/v1` API
carries a SECOND, independent per-API-key limiter on top (§1.6). No
unprotected anonymous surface found; no new rate-limit code needed.

### 1.8 Exhaustive cross-tenant isolation re-verification

`apps/api/test/tenant-isolation-exhaustive.e2e-spec.ts` — ONE new,
consolidated suite (the individual per-module suites already assert
isolation informally within their own scope; this is the first single
file that walks EVERY module built from 0.x through 6.1 in one place) —
creates two tenants, seeds real representative data in tenant A across
every module, and asserts tenant B's authenticated session (JWT, and
an API key where relevant) can never read/list/update/delete tenant A's
rows: expect 403/404/empty-list, never leaked data. Runs against the SAME
RLS mechanism already proven to hold through PgBouncer pooling
([scaling-data-layer.md](./scaling-data-layer.md)) and native table
partitioning ([partitioning-archival.md](./partitioning-archival.md)) — no
special-casing needed, since RLS is enforced in Postgres itself, not
reimplemented per route.

`apps/api/test/tenant-isolation-exhaustive.e2e-spec.ts` (**63 tests**, all
passing) creates two tenants and, for every module below, either seeds a
real row via the actual HTTP-facing service (preferred) or directly via
the owner `prisma` client (where a full business-rule-valid row is heavy
to construct — e.g. a full pack-driven payroll run, a full ATS approval
chain), then asserts tenant B's session can never see it:

- **Full-depth** (list + get-by-id + at least one mutation-non-landing
  check, i.e. the target row is confirmed UNCHANGED afterward via the
  owner client, not just "got the right status code"): employees
  (including a direct assertion that the encrypted salary/bank fields
  never appear in ANY response body, even an error body), leave (requests
  - balances), attendance, performance (goals + cycles), recruitment
    (requisitions/postings/candidates, plus the PUBLIC careers API proven
    tenant-scoped — visible under tenant A's Host, never tenant B's),
    operations modules (expenses/assets/helpdesk/announcements), LMS,
    integrations (webhook subscriptions + API keys, including a tenant-A
    API key proven to read only tenant-A data via `/v1/employees`, a
    SEPARATE auth path from JWT entirely), branding, benefits, custom
    fields, audit log (a positive control proving tenant A's own audit
    trail is populated, PLUS the negative — tenant B's audit log never
    contains a tenant-A entity id or actor id).
- **Lighter treatment** (list + get-by-id only, surrounding chains seeded
  directly rather than re-exercising a full multi-step business flow
  already proven end to end in that module's own dedicated suite):
  payroll runs, onboarding/offboarding, migration import batches,
  e-signature requests, statutory reports, privacy data-subject requests,
  analytics rollups (one seeded snapshot row, not the scheduled job
  itself), billing (read-only — no mutation attempted against real
  Stripe-adjacent state).
- **Two additional generic checks**: a tenant-A JWT replayed against a
  request resolved to tenant B (and vice versa) is rejected outright — a
  DIFFERENT attack shape from "authenticated as tenant B, address tenant
  A's own id"; a crafted `?tenantId=` query param cannot override the
  real resolved tenant (RLS/cache boundary both hold).
- **Explicitly out of scope, documented in-file rather than silently
  skipped**: Department/CostCenter/Designation have no dedicated HTTP
  list/get route in this codebase (referenced by id only, from other
  modules' own create calls) — their isolation is already covered
  generically by `packages/db/test/tenant-isolation.spec.ts`'s own
  crafted-`where`-clause proof; SSO wasn't named in this step's own
  module list.

**Zero real bugs found** — every cross-tenant read/list/get/mutation
attempt was already correctly blocked (403/404/empty-list) by the
existing RLS + service-layer scoping; no fix was needed anywhere outside
this one new test file.

### 1.9 Dependency + secret scanning (new CI pipeline)

**No CI workflow existed anywhere in this repo before this step** — no
`.github/workflows/` directory at all. `.github/workflows/ci.yml` adds:

- `build-lint-test` — brings up the SAME `docker-compose.yml` local infra
  (Postgres/Redis/MinIO) a contributor already runs locally, applies
  migrations (`prisma migrate deploy`, no shadow DB needed), then
  `pnpm build` / `pnpm lint` / `pnpm test -- --runInBand` (Turborepo fans
  each out per workspace; `--runInBand` forwarded to every workspace's own
  jest config, since this codebase's e2e suites share a single Postgres/
  Redis instance and are not designed for parallel worker execution), then
  `pnpm audit --audit-level=high`, `continue-on-error: true` —
  INFORMATIONAL for now, not yet a hard gate: this repo has pre-existing
  transitive-dependency advisories that haven't been triaged one by one,
  and turning this into a hard failure before that triage would just block
  every future PR on pre-existing noise. Tightening it to a real gate at a
  chosen severity threshold is a documented, deliberate follow-up, not an
  oversight.
- `secret-scan` — `gitleaks/gitleaks-action@v2`, pinned to a release tag,
  no paid service/account required — scans the full git history on a push
  to `main` and the PR diff on a `pull_request` event.

### 1.10 On-prem/self-host hardening checklist

See [`../../docs/security-checklist.md`](../../docs/security-checklist.md)
— a practical checklist for a lifetime-license customer deploying this
codebase on their own infrastructure (see CLAUDE.md §1 — the on-prem
delivery model is the SAME codebase, config/flags only, never a fork):
secrets rotation, TLS termination, the CORS/CSP env vars to actually set,
the backup/restore drill cadence (§3), MFA posture recommendations, and
what "verified-locally" vs. "verify before you rely on it in production"
means for each item.

## 2. Accessibility (WCAG 2.1 AA)

`@axe-core/playwright` added to both `apps/portal` and `apps/admin`
(devDependency only — no runtime/production dependency added). One new
spec per app (`tests/accessibility.spec.ts`), reusing each app's EXISTING
fixture/login/RTL conventions exactly (`rtl.spec.ts`'s LTR/English vs.
RTL/Arabic pairing for portal; `auth.spec.ts`'s real mandatory-MFA login
flow for admin) — every scan asserts zero violations tagged
`wcag2a`/`wcag2aa`/`wcag21aa`.

- **Portal** (`apps/portal/tests/accessibility.spec.ts`): `/login`
  (unauthenticated), the ESS dashboard in BOTH LTR/English
  (`employeeAEmail`) and RTL/Arabic (`qaEmployeeAEmail`, the QA Country
  Pack's own resolved direction), `/leave` (list + the "apply for leave"
  modal, LTR AND RTL), and `/payroll` (an admin-console-shaped page, as
  `adminAEmail`).
- **Admin** (`apps/admin/tests/accessibility.spec.ts`): `/login`'s
  password-only step, the MFA challenge step (an already-enrolled admin),
  the post-login `/dashboard`, `/tenants`, and the "New tenant" modal
  (focus trap + labeled fields).

**Real issues found and fixed** (not blind ARIA-sprinkling — each tied to
a specific WCAG success criterion):

- `Modal` (both apps, `components/ui/Modal.tsx`) — no focus management at
  all: opening didn't move focus in, closing didn't restore it, Tab could
  escape the dialog entirely. Fixed: focus moves to the first focusable
  element on open, a Tab/Shift+Tab cycle stays within the panel while
  open, focus returns to whatever triggered the modal on close, and the
  dialog gets `aria-labelledby` pointing at its own heading (2.4.3, 2.1.2,
  4.1.2).
- Color contrast (`tailwind.config.ts`, both apps) — `ink-400` (3.84:1 on
  white) and `amber-600` (3.69:1 on amber-50), both below the 4.5:1
  normal-text minimum (1.4.3), corrected at the TOKEN (not per call site,
  since each is used in ~100+ places) to `#657084` (5.00:1) and `#94600d`
  (5.03:1) respectively — with one exception documented in place:
  `Sidebar.tsx`'s one dark-background usage of the (light-surface-tuned)
  `ink-400` token switched to `ink-300` instead of relying on the
  light-surface fix.
- `PageSpinner` (both apps) — a loading state conveyed only by an
  `aria-hidden` animated icon announces nothing to a screen reader; added
  `role="status"` + visually-hidden "Loading…" text (4.1.3).
- Icon-only buttons with no accessible name — a refresh button
  (`aria-label` + a new `common.refresh` i18n key, both locales), a photo
  capture toggle (`aria-label` + `aria-pressed` reflecting state), a
  notifications bell (`aria-label` including the live unread count) (4.1.2,
  1.1.1).
- Interactive `<div>`/`<tr onClick>` elements with no keyboard equivalent —
  a performance cycle row's click target became a real `<button>` (can't
  nest a second interactive control inside an interactive row); an
  offboarding process row (which has no separate clickable name) instead
  got `role="button"` + `tabIndex={0}` + `aria-expanded` + `Enter`/`Space`
  handling, matching the WAI-ARIA pattern for a non-native toggle control
  (2.1.1).
- A custom dropdown menu (`Topbar.tsx`'s user menu) had no `Escape`-to-
  close and no outside-click-to-close — added both, plus `aria-expanded`
  on the trigger (2.1.2, 4.1.2).

**Honest, axe-structurally-uncatchable gaps — manual-audit-only, not
covered by this step's automation**: axe-core proves attributes/roles/
contrast/names are PRESENT and well-formed, never that a screen reader
narrates a genuinely sensible flow, that an `aria-label`'s WORDING is
actually meaningful (only that one exists), or judges cognitive load/
task complexity. A real screen-reader pass (VoiceOver/NVDA/JAWS) end to
end, and a cognitive-load review of the more data-dense admin-console
pages (payroll runs, analytics), remain manual-audit items for a future
step.

**Verified (2026-09-16, this closeout session)**: both suites re-run fresh
against real Chromium via `npx playwright test tests/accessibility.spec.ts`
(not assumed from the original implementation session) — `apps/portal`
**6/6 passing** (`/login` unauthenticated; ESS dashboard LTR/English and
RTL/Arabic; `/leave` list + the "apply for leave" modal, both LTR and RTL;
`/payroll`), `apps/admin` **5/5 passing** (`/login`'s password step and its
MFA-challenge step; `/dashboard`; `/tenants`; the "New tenant" modal) — 11
tests total, zero axe violations tagged `wcag2a`/`wcag2aa`/`wcag21aa`, no
new fixes needed this session (the fixes listed above were already in
place and held).

## 3. Backups + disaster recovery

Scripts + runbook live under `ops/backup/` (a new top-level directory — no
`ops/`/`security/` directory existed before this step; kept top-level
rather than nested under `deploy/`, since backup/DR is an operational
concern parallel to, not part of, `deploy/k8s/`'s deployment manifests).

- **`ops/backup/backup-postgres.sh`** — a full `pg_dump -Fc` of the primary
  (owner role — the same "migrations/admin tooling only" role
  [tenancy-rls.md](./tenancy-rls.md) already restricts to non-request-time
  use), GPG-AES256-encrypted at rest (`BACKUP_ENCRYPTION_KEY`, the same
  "env var, documented, never hardcoded, rotate outside source control in
  any non-local environment" posture `FIELD_ENCRYPTION_KEY`/`JWT_SECRET`
  already carry — see `apps/api/.env.example`). A native `pg_dump` against
  a NATIVELY PARTITIONED table (`attendance_records`/`audit_log`/
  `platform_audit_log`, step 5.2) transparently dumps the parent + every
  partition — no special-casing needed for partitioning to be covered.
- **`ops/backup/backup-minio.sh`** (+ `minio-export.js`, reusing
  `@aws-sdk/client-s3` — already an `apps/api` dependency, no new SDK) —
  exports the FULL object-storage bucket (documents/payslips from 1.1/2.1,
  AND the partition-archival exports `PartitionArchivalService` (step 5.2)
  already writes there), tars, GPG-encrypts the same way.
- **`ops/backup/restore-drill.sh`** — decrypts a real backup artifact and
  restores it into a disposable SCRATCH database (never the live one),
  then runs REAL verification: row-count/sample-row data-integrity proof
  across 5 representative tables (`tenants`/`users`/`employees`/
  `branches`/`audit_log`), RLS enforced identically on the restored
  database (`hrm_app` with no tenant context fails loudly; with a real
  tenant id set, sees only that tenant's rows), and `audit_log`'s
  DB-level immutability (`REVOKE UPDATE/DELETE`) surviving the restore.
  **Actually run, twice, both fully green**, against the live local
  stack (13 tenants/639 users/628 employees/247 `audit_log` rows; a
  1,089,262-byte dump restored + fully verified in 48–68s; the live
  `hrm_dev` database untouched throughout, a disposable
  `hrm_dr_drill_<timestamp>` DB dropped afterward every time) — see
  `ops/backup/DR-RUNBOOK.md` for the full captured terminal output and
  the BUILD_LOG entry for the summary.
- **`ops/backup/DR-RUNBOOK.md`** — RPO/RTO targets + reasoning, the
  step-by-step recovery procedure, and an explicit verified-locally vs.
  verified-at-deploy split (real cross-region replication, a real cloud
  KMS for `BACKUP_ENCRYPTION_KEY`, and restore timing at production data
  scale are NOT provable in this sandboxed environment — stated honestly,
  matching [deployment-scaling.md](./deployment-scaling.md)'s and
  [observability-load.md](./observability-load.md)'s own verified-vs-at-
  deploy framing for their own claims).

**Residency**: backup artifacts must stay in the same region as the source
data they're backing up (the same `DEPLOYMENT_REGION`/`Tenant.hostingRegion`
constraint step 6.1's residency enforcement already establishes — see
[privacy-residency.md](./privacy-residency.md)) — true cross-region backup
replication for a genuinely multi-region deployment is a documented SEAM,
not something these scripts enforce today, the same honesty
[partitioning-archival.md](./partitioning-archival.md) already applies to
`TenantRetentionOverride`.

## Verified

This closeout (2026-09-16) re-ran every claim in this document fresh —
against the live local stack, not assumed from the original implementation
session — and fixed the one real gap it found along the way (a pre-existing
5.2 test-isolation bug, not a 6.2 regression; see the `docs/BUILD_LOG.md`
"6.2 verified" entry for the full story).

### Verified locally (this session, real commands, real output)

- **Full regression, green.** `pnpm build` (6/6 workspace tasks) and
  `pnpm lint` (8/8 workspace tasks). `pnpm test -- --runInBand` across
  every workspace that carries Jest suites: `@hrm/api` **68 suites / 678
  tests**, `@hrm/db` **6 suites / 37 tests**, `@hrm/mobile` **4 suites / 19
  tests** — zero regressions anywhere in the codebase, not just in this
  step's own new files.
- **The three suites this closeout was specifically asked to re-verify**,
  run individually for exact counts: `tenant-isolation-exhaustive.e2e-spec.ts`
  **63/63**, `tenant-mfa.e2e-spec.ts` **13/13**, `security-headers-cors
.e2e-spec.ts` **6/6** — 82/82.
- **The restore drill, actually run to completion, not just re-read.** A
  brand-new `backup-postgres.sh` run against the CURRENT `hrm_dev` (which
  now includes 6.1's privacy tables and the new MFA columns/migration —
  schema/data the drill had never been exercised against before) produced
  a fresh encrypted artifact; `restore-drill.sh` ran against it end to end,
  completely unmodified, and passed on the first try: row counts match for
  `tenants`/`users`/`employees`/`branches`/`audit_log` (14/640/627/16/35
  source vs. restored), a sample tenant row byte-identical, `hrm_app` with
  no tenant context fails loudly on the restored database, `hrm_app`
  scoped to one tenant sees exactly that tenant's 3 branches and none of
  the other 13, and `hrm_app` UPDATE/DELETE against the restored
  `audit_log` are both rejected with `permission denied` — the scratch
  database (`hrm_dr_drill_20260916055352`) dropped automatically
  afterward, the live `hrm_dev` never touched.
- **Accessibility, both apps, real Chromium.** `apps/portal` 6/6,
  `apps/admin` 5/5 — see §2's own verified line above.
- **A real bug found and fixed by this closeout's own regression run**:
  `packages/db/test/partitioning.spec.ts`'s idempotency test assumed
  `Date.now() % 100` gave it a test month "unique to this run" and never
  cleaned up after itself; after enough historical runs it collided with
  its own leftover state (five stale `audit_log` partitions from
  2030-2036 were sitting in the dev DB). Fixed with a wider slot space
  (`process.hrtime.bigint() % 4500n`) and a `finally`-block self-cleanup —
  this is exactly the category of gap a full, honest re-run (rather than
  trusting a prior session's "it passed once") is supposed to catch.

### Verified at deploy (not provable in this sandboxed environment)

Consistent with the same honesty framing [deployment-scaling.md](./deployment-scaling.md),
[observability-load.md](./observability-load.md), and this document's own
§1.2/§3 already apply to their own claims:

- **A real cloud secrets manager for `ENCRYPTION_KEY_PROVIDER`/
  `BACKUP_ENCRYPTION_KEY`.** `CloudSecretsProvider` is a documented
  `NotImplementedException` seam; only `EnvSecretsProvider` has ever run.
  A real AWS Secrets Manager/Vault integration, and a real KMS holding
  `BACKUP_ENCRYPTION_KEY`, need to be written and exercised against that
  actual service before production reliance.
- **TLS termination and HSTS under a real browser/CDN/load-balancer
  chain** — `helmet`'s headers are proven present in every response this
  session, but a real certificate, real HSTS-preload behavior, and a real
  CDN/WAF sitting in front were never exercised (no such infrastructure
  exists in this sandbox) — see [deployment-scaling.md](./deployment-scaling.md)'s
  identical caveat for its own ingress/TLS claims.
- **`gitleaks` secret scanning and the CI pipeline as a whole** have never
  run inside GitHub Actions itself in this environment — the workflow
  YAML is written and its steps mirror commands verified locally
  (`pnpm build`/`lint`/`test`, `pnpm audit`), but GitHub's own runner
  environment, its Postgres/Redis/MinIO service-container wiring, and a
  real `gitleaks-action` run against this repo's actual history are only
  provable once a PR actually opens against `main`.
- **Restore timing and integrity at production data scale.** This
  session's drill (and the two prior development-time runs recorded
  above) all ran against a dev-sized database (hundreds of rows, low
  hundreds of MB); restore duration and any large-object/partition-count
  edge cases at a real tenant base's actual data volume are unverified.
- **A real screen-reader pass** (VoiceOver/NVDA/JAWS) and a cognitive-load
  review of data-dense admin pages remain manual-audit items, exactly as
  §2's own "honest, axe-structurally-uncatchable gaps" paragraph already
  states — axe-core proves attributes/roles/contrast/names are present and
  well-formed, never that they narrate a genuinely sensible experience.
- **Optional tenant MFA has no portal enrollment UI** (§1.3's own
  deliberate scope cut) — the backend is fully tested, but nobody has
  clicked through a real browser enrollment flow because there is nothing
  to click through yet.
