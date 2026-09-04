# White-label / branding

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 4.3 (Phase 4's final slice) — `packages/db`, `packages/shared`,
`apps/api/src/branding`, `apps/api/src/platform/branding`, `apps/portal`,
`apps/mobile`, `apps/admin`. Lighter than 4.1/4.2 by design — mostly a
tenant-configurable theming/branding layer CONSUMING systems that already
exist: tenant resolution (0.3, extended), feature flags (0.6, reused
unmodified for the gated capability), notifications (0.8, extended), audit
(0.9, extended), RLS (0.2). Nothing about the payroll engine, billing, auth
core, or tenant RLS's fundamental design changed for this step.

## 1. Per-tenant branding — the model

`TenantBranding` (schema.prisma) is an ordinary tenant-scoped table —
`@@unique([tenantId])`, normal RLS (`tenant_isolation` policy, same
pattern as every other tenant-owned table since 0.2). Holds `productName`,
`logoStorageKey`/`faviconStorageKey` (S3/MinIO keys via the EXISTING 1.1
`StorageService`, reused unmodified), `primaryColor`/`secondaryColor`/
`accentColor` (hex strings, applied as inline styles/CSS custom properties
client-side — no server-side theming logic), `loginHeadline`/
`loginSubtext`, `emailFromName`/`emailFromAddress`, and the gated
`fullRebrandEnabled` bit (§ 4).

**Absence means default** — a tenant with no `TenantBranding` row at all
(the common case) resolves the plain product defaults
(`@hrm/shared`'s `DEFAULT_PRODUCT_NAME = 'HRM'`), the same posture
`NotificationPreference` already takes for itself (see
[notifications-queues.md](./notifications-queues.md)).

### Resolution is a hot-path read — cached the same way rate limits/idempotency already are

`BrandingResolutionService` (`apps/api/src/branding/branding-resolution.service.ts`)
is the one place ANY caller resolves effective branding — every portal/
mobile page load, every outbound notification render, and the pre-login
screen all go through it. Results are cached in Redis
(`branding:<tenantId>`, a 60s TTL) via `REDIS_CLIENT`, the SAME token
`IdempotencyService`/`RateLimiterService` already use for cross-instance
state (see [resilience.md](./resilience.md)) — not a new caching
subsystem. Every write (`BrandingService.update`/`uploadLogo`/
`uploadFavicon`/`updateRebrand`, and the platform's own `resetBranding`)
explicitly invalidates the key; the TTL is a safety net for a missed
invalidation, not the primary consistency mechanism.

Two resolution entry points, mirroring `NotificationLocaleResolverService`'s
own documented split (see [notifications-queues.md](./notifications-queues.md)):
`resolve(tx, tenantId)` for a caller already inside the tenant's RLS-scoped
transaction (ordinary requests, including `@AllowAnonymous()` ones — tenant
resolution runs for those too, see [tenant-resolution.md](./tenant-resolution.md));
`resolveForTenantId(tenantId)` for a caller with no open transaction (the
notification worker), which checks the cache first so the warm case never
even opens one.

**`fullRebrandEnabled` is cached alongside the rest but is NOT itself an
entitlement** — see § 4.

## 2. Theme tokens across portal, mobile, and email

- **`GET /branding`** (`@AllowAnonymous()` — tenant resolution alone is
  enough, no JWT) returns the public-safe subset (`productName`, `hasLogo`/
  `hasFavicon` booleans, colors, login copy, and the LIVE-computed
  `showPoweredBy`) plus `GET /branding/logo`/`GET /branding/favicon`
  (also `@AllowAnonymous()`, streamed via `StorageService.downloadObject`
  exactly like 1.1's employee-document downloads). This is what makes the
  PRE-LOGIN screen brandable: tenant resolution (subdomain/header) happens
  before auth, so there's a real tenant to resolve branding for even with
  no user signed in yet.
- **`apps/portal`**: `BrandingProvider` (`lib/branding/BrandingProvider.tsx`)
  is mounted at the ROOT layout, INSIDE `<AuthProvider>` (not outside, and
  not `apps/portal`'s own historical "outer providers don't need auth"
  pattern) — **it re-fetches whenever `AuthContext`'s `user` changes, not
  just once on mount.** This is a real, load-bearing fix, not a defensive
  nicety: this app's own Playwright suite runs the HEADER tenant-resolution
  strategy (see [tenant-resolution.md](./tenant-resolution.md)), where a
  genuinely fresh visitor has NO stored tenant slug at all until they type
  it into the login form — the very first resolution attempt (on mount,
  pre-login) legitimately 401s and falls back to plain defaults.
  `AuthContext.login()` calls `setStoredTenantSlug()` BEFORE it ever
  updates `user`, so re-running the fetch on that transition is what
  picks up the REAL branding instead of staying stuck on the stale
  default forever — caught by this step's OWN Playwright suite (a fresh
  login showed the tenant's default name, not its branded one, until this
  fix), not a theoretical concern. Subdomain-strategy deployments don't
  depend on this at all (the tenant is resolvable from the hostname alone
  pre-login); this is what makes the header-strategy case correct too.
  A settings-page mutation (save/upload/rebrand-toggle) explicitly calls
  the context's own `refresh()` afterward, since it's a SEPARATE fetch
  from the shared provider's — a save doesn't itself change `user`.
  Logo/favicon are fetched as blobs via the EXISTING `apiFetchBlob`
  primitive (2.4) and applied via `URL.createObjectURL` — the same reason
  a plain `<img src="/branding/logo">` wouldn't work in header-strategy
  dev (an `<img>` tag can't attach the `x-tenant-id` header).
- **`apps/mobile`**: `BrandingProvider` (`src/theme/BrandingContext.tsx`)
  mirrors the portal's re-fetch-on-`user`-change design, mounted inside
  `<AuthProvider>` in `App.tsx` — mobile has NO hostname of its own at all
  (see [frontend-ess-mss.md](./frontend-ess-mss.md)) and ALWAYS uses the
  header strategy, so this matters even more here than on the web. Applied
  to `LoginScreen`'s app name/headline/subtext and `SettingsScreen`'s
  "Powered by" line. Deliberately does NOT fetch the logo/favicon image
  (no equivalent of the web's object-URL pattern) — see § 6's gaps.
- **Transactional email**: `NotificationTemplateRenderer.render` now takes
  `tenantId` and merges `{ productName: effective.productName, ...payload }`
  before `{{placeholder}}` interpolation (via the EXISTING
  `interpolateTemplate`, unchanged) — so ANY notification template can
  reference `{{productName}}`. The two password-reset templates
  (`seed-notification-templates.ts`, en + ar) were updated from a
  hardcoded "HRM" to `{{productName}}` as the concrete, real proof this
  works, not just a plumbing exercise. `NotificationDeliveryService`
  additionally resolves the tenant's `emailFromName`/`emailFromAddress`
  (falling back to `DEFAULT_EMAIL_FROM_NAME`) and passes them as new
  `fromName`/`fromAddress` fields on `NotificationProviderSendParams` —
  `LogEmailProvider` logs them; a real ESP integration would set the
  actual `From:` header from these. **Documented gap**: there is no
  sender-domain verification step (SPF/DKIM) for a tenant-supplied
  `emailFromAddress` — a real deployment would need the ESP's own domain
  verification before trusting an arbitrary tenant-entered address as a
  `From:`, out of scope for this step (no real ESP is wired at all yet,
  see [notifications-queues.md](./notifications-queues.md)'s own
  documented provider seam).

## 3. Branded custom domains — extending the EXISTING resolution strategy

`TenantDomain` (0.3) already had a `custom_domain` tenant-resolution
strategy, but no write path and no ownership-verification concept — this
step gives it both, without touching the table's fundamental RLS-EXEMPT
status (still required: resolving a request's tenant from its Host header
has to happen before a tenant context exists to filter by — see
[tenancy-rls.md](./tenancy-rls.md)).

- **New columns** (additive, all defaulted/nullable): `verificationStatus`
  (`PENDING_VERIFICATION` | `VERIFIED` | `FAILED`), `verificationToken`,
  `certStatus`/`certProvisionedAt`/`certExpiresAt`, `requestedByUserId`.
- **`TenantResolutionService.resolveByCustomDomain` now requires
  `verificationStatus === 'VERIFIED'`** — a freshly-requested
  (`PENDING_VERIFICATION`) row must never resolve real tenant traffic, or
  any tenant admin could hijack another domain's traffic just by
  requesting it first. Proven directly in the e2e suite: a request against
  a just-submitted domain 401s (unresolvable) until a platform admin
  approves it.
- **The write path deliberately does NOT go through `tx`.** Since
  `TenantDomain` stays RLS-exempt, a tenant-authenticated request's own
  `hrm_app`-role `tx` can't be trusted to enforce "only write your own
  tenantId" the way RLS does everywhere else — so `BrandingService`'s
  domain methods (`requestDomain`/`getDomain`/`deleteDomain`) go through
  the OWNER `prisma` client instead, explicitly filtering/scoping by the
  caller's own `tenantId` in application code every time. This is the
  same "RLS can't help on an RLS-exempt table, the app itself must be the
  enforcement" pattern `PlatformTenantService`/`StripeWebhookService`
  already use for `Tenant.status` writes — extended here to a genuinely
  NEW shape: an ordinary TENANT-authenticated route (not a platform one)
  partially writing through the owner client. **Documented, accepted
  tradeoff**: this means a domain-request mutation's audit-log write
  (via `AuditInterceptor`, inside the request's own `tx`) and the
  `TenantDomain` row itself (via the owner client, its own implicit
  transaction) are not part of the same atomic unit — an extremely
  unlikely mid-request failure could leave one without the other. The
  domain's own `@@unique(domain)` constraint is what actually matters for
  correctness (no two tenants can ever claim the same domain), not this
  narrow audit-atomicity gap.
- **Verification — two paths, one real, one a documented, loudly-audited
  override**: `DomainVerificationService.verify()` does a real DNS TXT
  lookup (`_hrm-verify.<domain>` = `hrm-verify=<token>`, Node's built-in
  `dns/promises`, no extra dependency — same "no extra dependency" posture
  0.9's timezone rendering/3.3's OIDC JWKS verification already take) —
  this IS the real production path. `PlatformBrandingController`'s
  `.../approve` action sets `VERIFIED` directly, WITHOUT a DNS check —
  because this sandboxed dev/CI environment has no outbound DNS
  resolution to a fixture domain either, the exact same "a real external
  dependency can't be fully exercised here, so a manual/mock fallback
  exists alongside the real path, loudly audited either way" posture 4.1's
  impersonation flow and 4.2's `MockStripeClient` already establish. The
  e2e/Playwright suites both exercise `approve`, not `verify`, for
  exactly this reason — deterministic, no network dependency.
- **TLS provisioning — a real, designed seam, not implemented against a
  live ACME directory.** `CERT_PROVIDER` (DI token,
  `apps/api/src/branding/cert/cert-provider.interface.ts`) — same
  bind-an-interface-to-a-token shape as `AUTH_PROVIDER` (0.4)/
  `STRIPE_CLIENT` (4.2). `MockCertProvider` (bound by default —
  `ACME_ENABLED` unset) "issues" a certificate immediately with a
  realistic ~90-day expiry, no network call — what lets the full suite
  run with no live CA account, the same reason `MockStripeClient` exists.
  `AcmeCertProvider` is the documented REAL seam: a real implementation
  would use a library like `acme-client` against `ACME_DIRECTORY_URL`
  with an account keyed by `ACME_ACCOUNT_EMAIL`, completing an HTTP-01 or
  DNS-01 challenge — genuinely NOT implementable end-to-end in this
  environment (unlike Stripe, real ACME issuance needs a publicly
  resolvable domain plus a reachable challenge responder, neither of
  which exists here), so this class throws `NotImplementedException`
  rather than pretending to work; swapping the binding in
  `branding.module.ts` (`ACME_ENABLED=true`) is the entire integration
  point, `PlatformBrandingService` needs no change either way. `provisionTls`
  requires `verificationStatus === 'VERIFIED'` first (400 otherwise) —
  ownership must be proven before a certificate is provisioned for a
  domain. **Real deployments terminate TLS at a proxy/load balancer in
  front of this Node app** (the standard shape for this stack), so
  `certStatus` is ops-tracking metadata the vendor console surfaces, not
  something this app itself uses to decide whether to serve HTTPS.

## 4. Full rebrand — a SOLD capability, gated by the EXISTING feature-flag engine

`FEATURE_FLAGS.FULL_REBRAND` (`packages/shared`) is ENTERPRISE-only in
`EDITION_FEATURES` — reuses 0.6's entitlement engine completely unmodified,
which is what makes it work identically for BOTH SaaS (an ENTERPRISE
`Subscription`) and lifetime/on-prem (an ENTERPRISE `License` with the flag
in its signed `enabledFlags`) tenants with zero new code.

- **Cosmetic branding (logo, colors, product name shown in the chrome,
  favicon, login copy, email identity, custom domain) is available to
  EVERY tenant regardless of this flag** — that's ordinary SaaS
  white-labeling, not what this flag gates.
- **What the flag actually gates: the "Powered by" vendor-identity footer**
  (`apps/portal`'s `PoweredByFooter` on the login screen and the
  authenticated app shell; `apps/mobile`'s `SettingsScreen` footer line).
  `PUT /branding/rebrand` is gated behind `@RequireFeature(FULL_REBRAND)`
  - `FeatureFlagGuard` — the EXACT existing mechanism (0.6), no bespoke
    entitlement check written for this step.
- **The stored `fullRebrandEnabled` bit is the tenant's INTENT, never
  trusted alone.** `showPoweredBy` (in `GET /branding`'s response) is
  computed as `!(fullRebrandEnabled && liveFlags.includes(FULL_REBRAND))`
  — the live flag resolution (`FeatureFlagResolutionService.resolve`,
  UNCACHED, called fresh) is re-checked on every read, the same "never
  cache entitlement itself" posture `FeatureFlagGuard`/`@RequireFeature`
  already document for themselves. Proven directly in the e2e suite: an
  ENTERPRISE tenant enables full rebrand (footer hidden), its subscription
  is then downgraded/canceled, and the footer reappears on the very next
  read — with ZERO change to the stored `fullRebrandEnabled` bit. A
  lapsed entitlement must restore vendor identity immediately, not up to
  60 seconds later (the branding cache's own TTL) — which is exactly why
  this check is deliberately NOT part of the cached `EffectiveBranding`
  payload.

## 5. Vendor oversight (`apps/admin`) — read broad, manage narrow

`PlatformBrandingController`/`PlatformBrandingService`
(`apps/api/src/platform/branding/`) — `PLATFORM_PERMISSIONS.BRANDING_READ`
(both platform roles) / `BRANDING_MANAGE` (PLATFORM_OWNER only), the SAME
"support can look, only the owner can act" split `BILLING_READ`/
`BILLING_MANAGE` already established in 4.2 — a deliberate precedent
match, not independently re-derived. List/detail reads are cheap indexed
queries only (`prisma.tenant.findMany`/`tenantBranding.findMany`/
`tenantDomain.findMany`, joined in application code, never a per-tenant
loop) — the same "cheap reads only, never a live heavy scan" posture
`PlatformUsageService` documents for itself.

Every mutation (`verifyDomain`/`approveDomain`/`provisionTls`/
`resetBranding`) is **dual-audited** exactly like 4.1's
`PlatformTenantService`/4.2's `PlatformBillingService`: the TARGET
TENANT's own `audit_log` (`AuditRecordService.recordForTenant`,
`actorPlatform: true`) AND the platform's consolidated `PlatformAuditLog`
— a tenant's own `TENANT_ADMIN`, using their perfectly ordinary `GET
/audit`, can see for themselves that the vendor touched their domain or
reset their branding, never only in a trail they can't see. Proven
directly in the Playwright suite by reading the tenant's own audit
entries via `prisma` after a vendor-console action.

`resetBranding` (`DELETE /platform/branding/tenants/:id/reset`) deletes
the tenant's `TenantBranding` row entirely (back to plain defaults) and
invalidates the cache — a policy-violation/support-requested lever, not a
routine action; the UI gates it behind a confirmation modal naming exactly
what it does.

`apps/portal`'s branding settings page (`/branding`, RBAC-gated
`branding.manage`, TENANT_ADMIN only via `ALL_PERMISSIONS` — ownership
territory, the same reasoning `billing.manage`/`license.manage` already
document for themselves) is the tenant-self-service side: logo/favicon
upload, colors, product name, login copy, email identity, a custom-domain
request-with-DNS-instructions flow, and the rebrand toggle (disabled with
an upsell notice when not entitled — `fullRebrandEntitled` is returned
directly by `GET /branding/settings`, computed the SAME live way as
`showPoweredBy`).

## 6. Testing + known gaps

- **Backend**: `apps/api/test/white-label.e2e-spec.ts` (21 tests) — public
  defaults, RBAC deny-by-default on every mutation, an admin's branding
  update reflected on an immediate re-read, cross-tenant isolation, a
  full logo upload→download byte-for-byte round trip, the branded
  product name actually appearing in a real outbound password-reset
  email's subject, full-rebrand deny-for-non-entitled/allow-for-entitled/
  LIVE-re-check-on-downgrade, a custom domain staying unresolvable until
  verified then genuinely resolving the right tenant end to end, a second
  tenant unable to claim an already-requested domain, PLATFORM_SUPPORT
  denied every MANAGE action, TLS provisioning refused before
  verification then succeeding after, the target tenant's own audit log
  showing a platform action, and a full platform-triggered reset.
  `apps/api`'s full suite: **468 tests green** (447 existing + 21 new),
  zero regressions.
- **`apps/portal`**: `tests/branding.spec.ts` (6 new Playwright tests) —
  an admin sets product name/color/logo through the REAL settings UI and
  the sidebar reflects it with NO page reload (proving the shared
  `BrandingProvider`'s explicit `refresh()` call, not just the settings
  page's own local state); a page reload re-resolves from the server; a
  DIFFERENT tenant never sees it; **a QA-branch (Arabic/RTL) employee
  sees the SAME branding correctly ALONGSIDE `dir="rtl"`** — the
  branding+RTL coexistence this step's brief specifically called for;
  RBAC deny for a plain employee; the "Powered by" footer visible for a
  non-rebranded tenant. Suite total: **82 tests green** (76 existing + 6
  new). One PRE-EXISTING, unrelated `operations-modules.spec.ts` test
  (an expense-claim-reaches-APPROVED assertion) flaked once under the
  full-suite's cumulative load and passed cleanly in isolation — the same
  class of test-parallelism flakiness `billing.md`/`vendor-console.md`
  already document for themselves elsewhere in this suite; no branding
  code is anywhere near that test.
- **`apps/admin`**: `tests/branding.spec.ts` (4 new Playwright tests,
  seeding a `TenantDomain` row directly via `prisma` — a real domain
  _request_ originates on the tenant portal side, out of this app's own
  scope, the same "this suite's job is the oversight actions on top of
  one" reasoning it already applies to seeding a target tenant user) —
  the overview lists a tenant's pending domain; PLATFORM_SUPPORT sees the
  branding card but not its MANAGE actions; PLATFORM_OWNER approves then
  provisions TLS, verified against the tenant's own real `audit_log` row;
  a full reset. Suite total: **14 tests green** (10 existing + 4 new).
- **`apps/mobile`**: no new automated tests (this step's own test list was
  backend-e2e/Playwright-focused, and no simulator is available in this
  environment to visually verify RN screens — see
  [frontend-ess-mss.md](./frontend-ess-mss.md)'s own documented
  verification limits). Re-verified: `tsc --noEmit` (0 errors), `eslint .`
  (0 errors/warnings), `jest` (19/19, unchanged — no branding-specific
  unit test was added since there's no pure-logic branding code on this
  app worth isolating), `expo export --platform android --platform ios`
  (both bundle cleanly with the new `BrandingContext`/`LoginScreen`/
  `SettingsScreen` wiring).
- Full-repo `pnpm build`/`pnpm lint` green across all 8 workspace tasks.
- **Known, documented gaps**: `apps/mobile` doesn't fetch/render the
  logo/favicon image itself (product name/colors/login copy/"Powered by"
  only) — a native image-caching story is a real follow-up, not attempted
  here. No sender-domain (SPF/DKIM) verification for a tenant-supplied
  `emailFromAddress` (see § 2) — moot today anyway, since no real ESP is
  wired (`LogEmailProvider` only). `AcmeCertProvider` is a designed,
  documented seam, not tested against a live Certificate Authority — see
  § 3. A tenant may request at most one custom domain at a time (delete
  the existing one to request a different one) — a deliberate scope
  simplification, not a schema limitation (`TenantDomain` itself allows
  many rows per tenant).
