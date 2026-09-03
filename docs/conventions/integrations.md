# Integrations (webhooks · public API · adapter seams · SSO)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.3 (Phase 3's final slice) — `packages/db`, `packages/shared`,
`apps/api/src/integrations`, `apps/api/src/auth/{api-key,sso}`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "3.3 integrations" entry) for the
full file list and verification notes. **PHASE 3 COMPLETE as of this step**
— see CLAUDE.md § 6. This is the "extend without forking" escape hatch named
in CLAUDE.md § 2: a tenant/vendor integration is now always a NEW adapter,
webhook subscription, or API key — never a fork of this codebase. Backend-
only by design (no `apps/portal` UI) — the task's own scope names
`packages/db`, `packages/shared`, `apps/api` only.

Reuses, unmodified: the 0.8 BullMQ queue pattern, the 0.10 circuit breaker +
per-tenant rate limiter, 0.4's RBAC/`PermissionsGuard`, 0.6's feature-flag
guard, 0.9's audit interceptor, 1.1's `EncryptionService`. Extends, never
rewrites: 0.4's `AUTH_PROVIDER` seam (SSO is a SEPARATE flow, not a second
binding — see below) and 1.3's biometric seam (a real device registry now
surrounds the unchanged `BiometricDeviceAdapter`/`ManualBiometricDeviceAdapter`).

## 1. Outbound webhooks

- **Catalog, not new events.** `@hrm/shared`'s `WEBHOOK_EVENT_TYPES`
  (`webhooks/event-types.ts`) is pure data mirroring exactly the events
  already emitted (`AUTH_EVENTS`/`LICENSING_EVENTS`/`WORKFLOW_EVENTS` plus
  the inline `payroll.*`/`performance.*`/`recruitment.*`/`checklist.*`/
  `helpdesk.*`/`lms.*` literals) — the SAME "pure data table, no new
  listener code per event" posture `NOTIFICATION_EVENT_TYPES` (0.8) already
  established. `WebhookDispatchListener` subscribes to the IDENTICAL
  `@OnEvent('auth.*')`/... wildcard namespace list `NotificationDispatchListener`
  already does — zero existing emitter changed. `auth.password_reset_requested`
  is the one deliberate exclusion (its payload carries a live credential-
  reset token); every other payload still passes through
  `redactSensitiveFields` (the same pass `AuditRecordService` uses) before
  being persisted or signed, as a second line of defense.
- **Core model**: `WebhookSubscription` (tenant-scoped: `url`, `eventTypes`
  (a plain `String[]`, validated against the catalog at the DTO layer —
  same "closed catalog lives in shared data, not the schema" posture
  `WorkflowInstance.entityType` takes), `status` ACTIVE/PAUSED,
  `signingSecretEncrypted`) → `WebhookDelivery` (one row per delivery
  ATTEMPT SET, `PENDING`/`SUCCEEDED`/`FAILED`/`DEAD_LETTER` +
  `attempts`/`lastResponseStatus`/`lastResponseBody`/`lastError` — the SAME
  shape `NotificationDelivery` (0.8) already established, reused
  deliberately). `WebhookDispatchService` (producer) creates
  `WebhookDelivery` rows in one transaction, THEN enqueues one BullMQ job
  per row AFTER commit — identical two-phase shape to
  `NotificationsService.handleDomainEvent`. Unlike notifications' recipient
  resolution, there is no "just-written, not-yet-committed" race to retry
  around: `WebhookSubscription` rows are pre-existing tenant CONFIGURATION,
  never created by the same transaction the triggering event describes.
- **Signing** (`webhook-signature.util.ts`, pure functions, Node's built-in
  `crypto` only): `t=<unix-seconds>,v1=<hex-hmac-sha256>` — the same
  Stripe/GitHub convention, chosen specifically because binding the
  timestamp INTO the signed material lets a receiver reject a stale/
  replayed delivery, not just an unsigned one. The signing secret
  (`whsec_...`, generated once at subscription creation, shown in that ONE
  response) is stored AES-256-GCM-encrypted (`EncryptionService`) —
  reversible, since the dispatcher needs the original value again for
  every future delivery; never hashed (hashing is for one-way-checked
  credentials, see API keys below).
- **Breaker-wrapped delivery** (`WebhookDeliveryService`, the consumer):
  `CircuitBreakerService.execute('webhook:<subscriptionId>', ...)` — ONE
  breaker PER SUBSCRIPTION, so one tenant's broken receiver endpoint can
  never affect delivery to any other subscription anywhere in the system,
  the same isolation granularity notifications already use per-CHANNEL. The
  SAME three-separate-transactions (read / send / write-final-status)
  retry-then-dead-letter shape `NotificationDeliveryService.deliver`
  established — reused verbatim, not reinvented.
- **Management** (`WebhookSubscriptionController`,
  `/integrations/webhooks/subscriptions`): `webhook.manage`-gated
  (TENANT_ADMIN only — ownership/security territory, the same reasoning
  `license.manage`/`audit.read` already document for themselves),
  `FEATURE_FLAGS.WEBHOOKS`-gated (a NEW flag, PROFESSIONAL+ — the same tier
  `API_ACCESS` already sits at) on every mutation, `@AuditLog`'d — this
  step's own brief calls out subscription changes as "especially"
  audit-worthy. `GET .../deliveries` is the delivery log (bounded, filtered
  live read — the SAME "operational drill-down, not a rollup" posture
  every other admin list screen in this codebase takes).

## 2. Versioned public API (`/v1`) + API keys

- **A SECOND, parallel authentication path, not a replacement for JWT.**
  `TenantScopeInterceptor` (0.3/0.4/0.10) gained ONE new branch: an
  `X-Api-Key` header is checked BEFORE `TenantResolutionService.resolve()`
  runs — an API key already embeds which tenant it belongs to (there is no
  subdomain a generic API client could call anyway), so host-based
  resolution is skipped entirely for this path. Everything downstream is
  identical to the JWT path: the SAME `withTenantContext` transaction, so
  RLS is enforced exactly the same way. `ApiKeyAuthService.validate` looks
  up candidates by the key's own prefix via the OWNER `prisma` client — a
  deliberate, narrow exception (there is no tenant context yet for this
  ONE lookup to run inside; the presented key is what establishes it), the
  same class of legitimate cross-tenant read `LicensingAdminService`/
  `WorkflowEscalationService`/`TicketSlaService` already document for
  themselves. `roles: []`, `permissions: scopes` — `PermissionsGuard`/
  `FeatureFlagGuard`/`PermissionSerializerInterceptor` all needed ZERO
  changes to enforce a key's scope: they already just read
  `TenantContextService.getPermissions()`.
- **Scopes reuse RBAC's own permission catalog** (`packages/shared`'s
  `PERMISSIONS`) — not a second, parallel vocabulary. A key's `scopes` are
  literally the permission set checked at request time.
- **Secrets — hashed, never encrypted.** `ApiKey.hashedKey` is an argon2id
  hash via the NEW `HashingService` (`apps/api/src/common/hashing/`,
  generalized out of `auth/password.service.ts`'s exact algorithm so this
  code doesn't reach into `AuthModule` internals) — one-way, only ever
  CHECKED via `HashingService.verify`, never decrypted. This is the
  opposite tradeoff from webhook signing secrets/SSO client secrets: an API
  key is compared, never reused in its original form by this system, so
  hashing (not encryption) is correct here. `keyPrefix` (the key's own
  first several characters, stored in the clear) identifies a key in the
  UI/logs without ever re-exposing the secret. The raw key is generated
  once, returned in the create response ONLY, and is unrecoverable after —
  list/read routes `select` every field except `hashedKey`.
- **Per-key rate limiting, independent of the per-tenant limit** —
  `ApiKeyRateLimitService`, the SAME `RateLimiterService` fixed-window
  primitive 0.10 built, keyed `api-key:<id>` instead of `tenant-quota:<id>`.
  Both limiters run on every API-key request — this codebase's "no single
  layer trusted alone" posture, restated. `ApiKey.rateLimitPerMinute`
  overrides `DEFAULT_API_KEY_RATE_LIMIT` (`packages/shared`) per key.
- **Management** (`ApiKeyController`, `/integrations/api-keys`):
  `api_key.manage`-gated (TENANT_ADMIN only), `FEATURE_FLAGS.API_ACCESS`-
  gated on creation (the SAME flag already seeded since 0.6, reused rather
  than inventing a new one) — deliberately JWT-only, never itself callable
  via an API key: minting/revoking the credential that grants API access is
  a step ABOVE what that credential can do of itself.
- **The `/v1` surface itself** (`V1Module`) is a DELIBERATE, CURATED slice
  (`GET /v1/employees[/:id]`, `GET /v1/leave/requests[/:id]`), not a mirror
  of every internal route — proving the auth path, scoping, rate limiting,
  tenant isolation, and OpenAPI generation end to end is this step's job;
  growing it to cover more resources is ordinary, incremental work for
  whenever a real integration needs a given one, the same "documented,
  deliberate scope boundary" posture payroll's single bank-export format
  already takes. Each controller reuses the EXISTING `EmployeeService`/
  `LeaveService` directly (imported via `EmployeesModule`/`LeaveModule`) —
  zero new business logic, only routing + `@ApiOperation` annotation.
  `V1LeaveController` requires the BROADER `leave.approve` scope (not
  `leave.read`) and always calls `canManageOthers: true`, since an API key
  has no linked "self" `Employee` the way a JWT-authenticated user does.
- **OpenAPI/Swagger** (`apps/api/src/swagger.ts`, called from both
  `main.ts` and any e2e test that needs it) — `@nestjs/swagger`,
  `SwaggerModule.createDocument(app, ..., { include: [V1Module] })`,
  served at `GET /v1/docs` (`/v1/docs-json` for the raw document). Scoped
  to ONLY the `/v1` surface, not this codebase's entire internal API — most
  of this codebase's DTOs are zod schemas, not class-validator-decorated
  classes, so full automatic schema inference isn't attempted; each `/v1`
  route carries its own `@ApiOperation` instead. An `addApiKey({type:
'apiKey', name: 'X-Api-Key', in: 'header'}, 'ApiKeyAuth')` security scheme
  documents the auth mechanism itself.

## 3. Adapter seams

All four follow the SAME Symbol-token + interface + `{provide, useClass}`
shape 0.4's `AUTH_PROVIDER`, 0.8's per-channel `NotificationProvider`s, 1.3's
`BIOMETRIC_DEVICE_ADAPTER`, and 2.1's `BANK_EXPORT_ADAPTER`/
`PAYROLL_PROVIDER_ADAPTER` already establish.

- **Accounting** (`apps/api/src/integrations/adapters/accounting/`) —
  `AccountingAdapter` (`exportPayrollRun`/`exportExpenseClaim`, e.g. for
  QuickBooks/Xero), bound today to `NoopAccountingAdapter` (logs + a
  synthetic `noop-<uuid>` reference, tagged so tests can assert THIS path
  ran — the SAME posture `StubPayrollProviderAdapter` already takes for its
  own category). `AccountingExportController` (`integration.manage`-gated)
  reads the run/claim directly off the caller's own RLS-scoped transaction
  and hands the row straight to the adapter — no transformation of its own.
- **Slack** — a REAL adapter (not a dev-only `Log*Provider`), reusing the
  0.8 provider seam exactly: `SlackNotificationProvider implements
NotificationProvider`, bound to a NEW `SLACK_PROVIDER` token alongside
  `EMAIL_PROVIDER`/`SMS_PROVIDER`/`PUSH_PROVIDER` in `notifications.module.ts`.
  `NotificationChannel` gained one additive enum value (`SLACK`) — opt-in
  only (absent from `DEFAULT_NOTIFICATION_CHANNELS`; a tenant enables it
  per event type via the existing `NotificationPreference` mechanism, and
  a `NotificationTemplate` row must exist for `(eventType, 'SLACK', locale)`
  or that delivery dead-letters loudly, the same "no `missing_ok`" posture
  template resolution already takes for every other channel). `to` for
  SLACK is the tenant's configured incoming-webhook URL
  (`SlackWorkspaceConfig`, one row per tenant, AES-256-GCM encrypted —
  reversible, since the provider needs the literal URL to POST to) rather
  than a per-recipient address — resolved by
  `NotificationDeliveryService.resolveSlackWebhookUrl`, the SAME "one
  additive per-channel `to`-resolution case" pattern PUSH's `User.pushToken`
  already established in 1.4. Wrapped by the EXISTING
  `circuitBreaker.execute('notification-provider:SLACK', ...)` call with
  zero changes to that call site's shape. `SlackConfigController`
  (`/integrations/slack/config`, `integration.manage`-gated) never returns
  the decrypted URL — write-only, matching SSO's client secret.
- **Biometric devices** — FORMALIZES the 1.3 seam rather than replacing it:
  `BiometricDeviceAdapter`/`ManualBiometricDeviceAdapter`
  (`apps/api/src/attendance/devices/`) are COMPLETELY UNCHANGED (only their
  DI token is additionally exported from `AttendanceModule` for reuse — the
  same "consumer imports the reused module" direction `ExchangeRateService`'s
  3.1 export already takes). NEW: `BiometricDeviceRegistration` (a
  per-tenant device registry, `hashedSecret` via `HashingService`) +
  `POST /integrations/biometric/devices/:deviceId/punches` — a REAL
  device-facing ingestion endpoint, `@AllowAnonymous()` (a physical device
  is not a logged-in user) but still tenant-resolved via the EXISTING
  `X-Tenant-Id` header strategy (0.3's "no per-tenant hostname" case,
  built for exactly this) and RLS-scoped, with `X-Device-Secret` as this
  route's own additional per-device credential check before
  `BIOMETRIC_DEVICE_ADAPTER` is ever called. Exactly the future this
  interface's own 1.3 doc comment already predicted: "a real integration
  will likely need its own device-authentication story... a documented
  decision for that future step, not this one."
- **Bank export** — FORMALIZES payroll.md's own documented "one reference
  CSV format, no per-country selection" gap into a genuinely PLUGGABLE
  choice: `BankExportAdapterRegistry` (`.register(format, adapter)` /
  `.resolve(format)`), seeded with the EXISTING `GenericCsvBankExportAdapter`
  (format `GENERIC_CSV`) plus a second, honestly-labeled
  `NachaStubBankExportAdapter` (format `NACHA_STUB` — proves pluggability,
  explicitly NOT a real NACHA file; a real one needs the actual fixed-width
  Batch Header/Entry Detail/Batch Control/File Control record layout per
  NACHA Operating Rules, deliberately not attempted here). Additive on top
  of the EXISTING `BANK_EXPORT_ADAPTER` single binding (untouched, still the
  default): `PayrollRun.bankExportFormat` (new nullable seam column) is
  resolved against the registry when set, falling back to the original
  binding when it isn't — every run created before this step has
  `bankExportFormat: null` and behaves identically to before, verified by
  the full pre-existing `payroll.e2e-spec.ts` suite staying green untouched.
  Never read by `PayrollEngineService`/the tax-and-statutory engine — bank
  export is orchestration/formatting only, exactly as payroll.md already
  states.

## 4. SSO — finishing the 0.4 seam

- **A SEPARATE flow, not a second `AUTH_PROVIDER` binding.**
  `AuthProvider.validate(tx, tenantId, email, password)` (0.4) is shaped
  for a password checked synchronously against one tenant's user table — a
  federated login is a fundamentally different, multi-request redirect
  dance with no password at all. `SsoAuthProvider` (`auth/sso/`) is a
  DIFFERENT interface/DI-token pair (`OIDC_AUTH_PROVIDER`/
  `SAML_AUTH_PROVIDER`); `AUTH_PROVIDER`/`LocalAuthProvider` are completely
  UNCHANGED by this step — password login still goes through exactly the
  path it always has. `SsoService` orchestrates the flow and, once an
  identity is established, calls the SAME `TokenService.signAccessToken`/
  `.issueRefreshToken` `AuthService.login` uses, so a client's resulting
  session is indistinguishable either way.
- **OIDC is the ONE real, cryptographically-verified provider** —
  `OidcAuthProvider`: a standard Authorization Code flow (redirect to
  `authorizationEndpoint`, exchange the returned `code` at `tokenEndpoint`,
  verify the `id_token`'s RS256 signature against the IdP's own published
  JWKS). Verification uses ONLY Node's built-in `crypto.createPublicKey`
  (imports a JWK directly — no extra dependency) plus `jsonwebtoken`
  (already a transitive `@nestjs/jwt` dependency, added here as a direct
  one since this is the first place this codebase verifies an EXTERNALLY-
  issued JWT rather than one it signed itself).
- **SAML is a formalized SEAM with an HONEST, documented gap** —
  `SamlAuthProvider.buildAuthorizationUrl` is real (a genuine SP-initiated
  AuthnRequest, HTTP-Redirect binding: deflate, base64, URL-encode, per the
  SAML 2.0 spec), but `handleCallback` throws `NotImplementedException`.
  XML signature verification (canonicalization, signature-wrapping-attack
  resistance) is real, non-trivial cryptographic surface area this step
  deliberately does not hand-roll without a certified library — the SAME
  "one real reference implementation, one documented gap" posture every
  other adapter category in this step takes (accounting/Slack-config/bank-
  export). **Never enable SAML against this implementation in
  production** — configure OIDC instead, or add a certified XML-DSig
  verifier before relying on SAML's response verification.
- **Per-tenant config** (`SsoConfig`, one row per tenant, `protocol`
  OIDC/SAML): `config` is a JSON blob validated by a protocol-discriminated
  zod union (`packages/shared`'s `ssoConfigInputSchema`) — the SAME "JSON
  column has no schema-level guarantee of its own, re-validated on read/
  write" posture every other JSON-configured feature in this codebase
  takes. OIDC's `clientSecret` is encrypted (`EncryptionService`) by the
  SERVICE layer before the row is ever written and NEVER returned
  decrypted on a read-back (`redactConfig`) — write-only, the same posture
  a webhook's signing secret and a Slack webhook URL both take for
  themselves, minus the "shown once" step since an admin can always type
  it in again to rotate it.
- **ENTERPRISE-gated, on every mutation and on login itself.**
  `PUT /auth/sso/config`, `POST /auth/sso/config/enabled`, AND
  `GET /auth/sso/login`/`.../callback` are all `@RequireFeature(FEATURE_FLAGS.SSO)`
  (unchanged since 0.6, ENTERPRISE-only) — a PROFESSIONAL tenant cannot
  even SAVE a config, let alone log in through one, and a config saved
  while ENTERPRISE stops being usable the instant a tenant downgrades
  (re-checked fresh every call, the same defense-in-depth `FeatureFlagGuard`
  already provides everywhere else).
- **State — Redis, short-lived, single-use.** `SsoService` generates an
  opaque `state` at `/login`, stores it `sso:state:<state> -> tenantId` for
  5 minutes, and deletes it the instant `/callback` consumes it — a second
  presentation of the same state (replay) is a `401`, the same "opaque,
  short-lived, per-flow token, consumed exactly once" shape
  `TokenService`'s refresh-token records and the 0.6 offline-activation
  challenge both already use.
- **Find-or-provision, never silently ambiguous.** A first-time identity
  (matched by the id_token's `email` claim) is provisioned as a real,
  ACTIVE `User` with an unusable random password hash (via `HashingService`
  — never a real, guessable password) and assigned the config's
  `defaultRoleName` role, which MUST already exist for the tenant (a `401`
  names exactly which role is missing, never a silent no-op). A repeat
  login for the same email finds the SAME user — never a duplicate.
  `allowedEmailDomains`, when set, rejects an out-of-domain identity before
  any user is ever created.
- **No tenant-id travels through `state`.** Both `/login` and `/callback`
  land on the SAME tenant subdomain/host (ordinary 0.3 tenant resolution
  applies to both, unchanged) — `state` only needs to prove "this exact
  flow, not a replay," never "which tenant," so cross-tenant confusion is
  structurally impossible by construction, not by an extra check.

## Cross-cutting

Every new table (`WebhookSubscription`/`WebhookDelivery`/`ApiKey`/
`SsoConfig`/`BiometricDeviceRegistration`/`SlackWorkspaceConfig`) is
ordinary tenant-scoped RLS — the identical `tenant_isolation` policy
pattern every table since 0.2 uses, in its own follow-up `enable_rls_for_*`
migration. Every mutating admin route (webhook subscriptions, API keys, SSO
config, biometric devices, Slack config) is `@AuditLog`'d — this step's own
brief calls out API-key and webhook-subscription changes as "especially"
audit-worthy. New permissions (`webhook.manage`/`api_key.manage`/
`sso.manage`/`integration.manage`) are TENANT_ADMIN-only (via
`ALL_PERMISSIONS`), the same ownership/security-territory reasoning
`license.manage`/`audit.read`/`role.manage` already document — deliberately
NOT copied into `HR_MANAGER`'s permission list. Secrets are never logged:
webhook signing secrets and the Slack webhook URL are AES-256-GCM
(`EncryptionService`, reversible — needed again later); API key and
biometric device secrets are argon2id-hashed (`HashingService`, one-way,
only ever compared) — never the wrong tool swapped for the other.

## Known, documented gaps for this phase

SAML response signature verification (see § 4 above — the one deliberate,
loudly-documented exception to "real, not just a stub" in this step).
`/v1` covers two resources (employees, leave), not the full internal API —
a deliberate, documented scope boundary, not an oversight (see § 2). NACHA/
SEPA bank-export formats remain unimplemented — only a stub proves the new
registry is genuinely pluggable (see § 3); payroll.md's own original gap
note still stands. No `apps/portal` UI for managing webhooks/API keys/SSO
config/adapters — this step is backend-only by its own explicit scope; a
future admin-console slice can surface these the same way 2.4 surfaced
Payroll/Performance/Recruitment.

Verified end-to-end over real HTTP by four new `apps/api/test/*.e2e-spec.ts`
files (34 tests: `integrations-webhooks.e2e-spec.ts` — a real domain event
producing a signed, HMAC-verifiable delivery; event-type/PAUSED filtering;
a permanently-failing endpoint tripping its own breaker and dead-lettering
without affecting a healthy sibling subscription; RBAC/feature-flag
deny-by-default; cross-tenant isolation; `integrations-api-keys.e2e-spec.ts`
— a scoped key authenticating a `/v1` call with no `Authorization`/`Host`
header at all, tenant isolation, scope enforcement, revocation, per-key
rate limiting independent of the per-tenant limit, the served OpenAPI
document, cross-tenant isolation; `integrations-sso.e2e-spec.ts` — a REAL
OIDC Authorization Code login against a local fake IdP with genuine RSA/JWKS
signature verification, find-or-provision, replay rejection,
`allowedEmailDomains` enforcement, ENTERPRISE gating (a PROFESSIONAL tenant
cannot save/enable a config), SAML's real AuthnRequest redirect + documented
501 on response verification, cross-tenant isolation;
`integrations-adapters.e2e-spec.ts` — the accounting stub against real
payroll-run/expense-claim rows, the biometric seam producing a real
`AttendanceRecord` through the UNCHANGED 1.3 adapter, and a REAL end-to-end
Slack notification reaching a local HTTP receiver through the full
channel/preference/template/circuit-breaker pipeline) plus
`bank-export-adapter.registry.spec.ts` (2 unit tests). `apps/api`'s full
suite green at 380 tests (344 existing + 36 new), zero regressions —
including the one pre-existing assertion (`licensing-saas.e2e-spec.ts`)
updated to expect the new `webhooks` flag in `PROFESSIONAL`'s edition flag
list. `apps/portal`'s Playwright suite (76 tests) and `apps/mobile`'s Jest
suite (19 tests) both verified green, untouched by this step. Full-repo
`pnpm build`/`pnpm lint` green across all eight workspace tasks.
