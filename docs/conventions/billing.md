# Billing (SaaS subscriptions via Stripe)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 4.2 (Phase 4's second slice) — `packages/db`, `packages/shared`,
`apps/api/src/billing`, `apps/api/src/platform/billing`, `apps/admin`,
`apps/portal`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "4.2 SaaS
billing" entry) for the full file list and verification notes. This step
closes the gap 0.6 and 4.1 both explicitly flagged for it: `Subscription`
rows drove SaaS-mode feature-flag entitlement since 0.6, but nothing in this
system had ever produced a real one — they only ever existed via
`seed-licensing.ts`, a test fixture, or a platform admin editing the row by
hand. `StripeWebhookService`/`BillingService` are now the SOLE real
producers.

## Scope — SaaS mode ONLY

> Lifetime/on-prem tenants pay via the 0.6 signed license-file path,
> completely unaffected by anything in this step — `apps/api/src/billing`
> never reads or writes `License`/`LicenseSigningService`/
> `LicenseVerificationService`, proven directly in the e2e suite (an AMC
> invoice created for a tenant leaves its `licenses` row count unchanged).
> The one deliberate bridge: `PlatformBillingService.createAmcInvoice` lets
> the vendor invoice ANY tenant (SaaS or lifetime) for annual maintenance
> — invoice-only, no Stripe Subscription object ever created for it — which
> is how a lifetime tenant, who otherwise never touches Stripe, can still be
> billed for ongoing support without inventing a second billing system.

`LICENSE_MODE`/`FeatureFlagResolutionService.resolveLifetime` (0.6) are
completely untouched by this step.

## 1. Pricing + seat metering

- **`@hrm/shared`'s `BILLING_PLANS`** (`constants/billing-plans.ts`) — a
  per-edition reference table (`seatMonthlyMinorUnits`/`setupFeeMinorUnits`/
  `currency`), the SAME "illustrative, not certified" posture
  `seed-country-packs.ts`'s tax/statutory figures already document for
  themselves. A real deployment authors its OWN Stripe Products/Prices (one
  real Price id per edition, `STRIPE_PRICE_STARTER`/`_PROFESSIONAL`/
  `_ENTERPRISE`, see `.env.example`) — `BILLING_PLANS` only feeds
  `MockStripeClient`'s in-memory catalog and this module's own
  setup-fee/proration-preview math once a real Price id takes over pricing
  for real Stripe calls.
- **Seat metering reuses THE 0.6 seat-count, not a new definition.**
  `SeatCapService.countActive` (extracted from that service's own `check()`
  this step, so `check()` and billing share one implementation) counts
  ACTIVE `User` rows — the SAME count 0.6's seat-cap enforcement and 4.1's
  usage metrics already read. `BillingService.changePlan` bills for exactly
  this count at the moment of change; `BillingSeatMeteringService` (a NEW
  daily scheduled BullMQ job, the SAME `onModuleInit` repeatable-job
  pattern 1.5's `AnalyticsRollupService` established) keeps Stripe's billed
  quantity in sync between explicit plan changes — `proration_behavior:
'none'` deliberately, so an employee joining mid-month never triggers a
  surprise same-day micro-charge; the new quantity simply applies at the
  next invoice, Stripe's own standard un-prorated-quantity-update behavior.

## 2. The Stripe seam — real vs. mock, one env var

`STRIPE_CLIENT` (`apps/api/src/billing/stripe/stripe-client.interface.ts`)
is the SAME Symbol-token + interface + `{provide, useClass}` shape as
`AUTH_PROVIDER`/`PAYROLL_PROVIDER_ADAPTER`/`ACCOUNTING_ADAPTER` — but this
interface names ONLY the operations this module actually calls (customers/
subscriptions/invoices/paymentMethods/setupIntents/webhooks), not a mirror
of the whole Stripe SDK.

- **`RealStripeClient`** wraps the real `stripe` npm package (pinned to
  v17, whose types still expose `current_period_end`/`invoice.subscription`
  directly — later SDK majors moved these onto line items, a real breaking
  change worth knowing about before bumping). Works against Stripe TEST or
  LIVE mode transparently — that's purely which key (`sk_test_...` vs.
  `sk_live_...`) it's constructed with, never a code branch.
- **`MockStripeClient`** (bound whenever `STRIPE_SECRET_KEY` is unset —
  `stripe.module.ts`'s factory) is an in-memory, deterministic fake of just
  enough of Stripe's object model to exercise `BillingService`'s real logic
  end to end with NO live account and NO network call — this IS what "use
  Stripe's TEST mode / a mockable Stripe client so the suite runs without
  live keys" means concretely here, and it's what the full e2e suite runs
  against. Its own `webhooks.constructEvent` reuses 3.3's EXISTING outbound-
  webhook HMAC util (`integrations/webhooks/webhook-signature.util.ts`,
  `verifyWebhookSignature`) — Stripe's real webhook signature scheme
  (`t=<ts>,v1=<hmac-sha256>`) is IDENTICAL to the one this codebase already
  uses for its own outbound webhooks, so the mock's signature verification
  is genuinely exercising the same algorithm a real Stripe delivery would
  need, not a bypass. Deliberately does NOT fire webhook events itself —
  see `billing.e2e-spec.ts`'s own header comment for why the "API call"
  side (this class) and the "async webhook" side (`StripeWebhookService`)
  are tested independently, matching how they're genuinely decoupled in
  production.
- **Proration in the mock is a simplified, own-computed simulation** (flat
  30-day period, `(newMrr - oldMrr) * daysRemaining/30`) — it exists to
  prove `BillingService`'s OWN handling of whatever Stripe returns is
  Decimal-safe and idempotent, not to reimplement Stripe's real billing
  engine. `RealStripeClient` never sets `latestProrationAmountMinorUnits`
  on its own `subscriptions.update` — the mock's proration number is a
  mock-only affordance for the interactive preview response; against a
  real Stripe account, the AUTHORITATIVE proration amount always arrives
  later via the `invoice.*` webhook (see §4).
- **Price id resolution** (`billing-pricing.util.ts`): `priceIdForEdition`
  reads `STRIPE_PRICE_<EDITION>`, falling back to a deterministic
  `price_mock_<edition>` id `MockStripeClient` recognizes.
  `editionForPriceId` is the reverse lookup `StripeWebhookService` uses to
  resolve a webhook's own price id back to an edition — an UNRECOGNIZED
  price id never silently changes a tenant's edition; the caller's
  previously-known edition is kept.

## 3. Subscription lifecycle → entitlement (now REAL)

`FeatureFlagResolutionService.resolveSaas` (0.6) is **completely
unchanged** — it already correctly read `Subscription.status`
(TRIAL/ACTIVE = good standing, PAST_DUE/CANCELED = an empty, blocked flag
set) from day one. What this step changes is WHO writes that row:

- **`BillingService.changePlan`** applies Stripe's response OPTIMISTICALLY
  (the caller sees their new plan immediately in the HTTP response).
- **`StripeWebhookService`** applies the SAME mapping
  (`BillingService.applySubscriptionFromStripe`, one function, reused by
  both paths so they can never disagree on how a Stripe object maps onto
  this schema) AUTHORITATIVELY, whenever Stripe's own `customer.
subscription.*` events arrive — the eventual source of truth for
  everything that can happen entirely on Stripe's side (a dunning retry,
  a card update via Stripe's own customer portal, ...).
- **`billing.subscription_activated`/`_past_due`/`_canceled`** (new
  `BILLING_EVENTS`, `apps/api/src/billing/billing-events.ts`) are emitted
  from the webhook path — added to `NotificationDispatchListener`'s and
  `WebhookDispatchListener`'s existing `@OnEvent('billing.*')` wildcard
  subscription (the SAME mechanical, additive change every prior namespace
  addition already made to these two listeners), and to
  `NOTIFICATION_EVENT_TYPES`/`WEBHOOK_EVENT_TYPES` (`@hrm/shared`).
  Recipients resolve to every ACTIVE `TENANT_ADMIN` in the tenant — the
  SAME "owning role" fallback `licensing.issued`/`.revoked` already
  establish (`NotificationRecipientResolverService`).

### PAST_DUE gates features; only a fully CANCELED subscription suspends the tenant

A deliberate, documented two-tier design, not an oversight:
`customer.subscription.updated` with `status: 'past_due'` disables gated
features (0.6's existing resolution already does this) but leaves the
tenant `ACTIVE` — an admin with a lapsed card should still be able to log
in and fix their payment method. Only `customer.subscription.deleted`
(Stripe's own terminal `canceled` state, reached after ITS OWN configured
dunning retries are exhausted) suspends the tenant
(`StripeWebhookService.handleSubscriptionDeleted` sets `Tenant.status =
'SUSPENDED'`) — this IS the "non-payment can drive suspension" tie-in to
4.1's tenant-suspension enforcement (`TenantScopeInterceptor` genuinely
blocks every request for a SUSPENDED tenant, including its own login
route). Dual-audited exactly like `PlatformTenantService.suspend` (4.1):
the target tenant's OWN `audit_log` (via the existing
`AuditRecordService.recordWithinTransaction` — reused inside the SAME
transaction the Subscription write itself runs in, so the audit entry and
the state change commit or roll back TOGETHER) and the platform's
consolidated `PlatformAuditLog`.

`Tenant.status` is written through the OWNER `prisma` client, never the
tenant-scoped `tx` — `hrm_app` (the role `withTenantContext` opens `tx`
as) is granted only `SELECT` on `tenants` (see
[tenancy-rls.md](./tenancy-rls.md)), the SAME reason
`PlatformTenantService.suspend` already uses the owner client for this
exact write. A real bug this caught during development: an earlier draft
called `tx.tenant.update(...)` here and failed with a Postgres `permission
denied for table tenants` the moment the suspend path was actually
exercised by a test — worth remembering for any future code that touches
`Tenant` from inside a tenant-scoped transaction.

## 4. Inbound Stripe webhooks — the one inbound-webhook endpoint in this system

`POST /billing/webhooks/stripe` (`StripeWebhookController`) — `@Public()`,
deliberately NOT `@PlatformRoute()`: Stripe cannot authenticate as a
platform admin, and there is no tenant subdomain/header for this request to
resolve either (Stripe doesn't know which of this deployment's tenants a
customer belongs to). Tenant resolution happens INSIDE
`StripeWebhookService` by looking up the event's own Stripe customer id
against `Subscription.stripeCustomerId` through the OWNER `prisma` client —
the same narrow, legitimate cross-tenant lookup class
`ApiKeyAuthService.validate` already establishes for its own non-tenant-
resolved caller. An event that resolves to no known tenant (a stale/test
object) is acknowledged `200` (so Stripe doesn't retry forever) and
recorded into `PlatformAuditLog` instead of crashing.

- **Raw-body signature verification.** `main.ts` passes `{ rawBody: true }`
  to `NestFactory.create` (and e2e tests must pass the same option to
  `moduleRef.createNestApplication(...)`) — Nest then keeps the exact
  request Buffer alongside its normally-parsed `req.body`, which
  `StripeWebhookController` hands to `StripeClient.webhooks.constructEvent`
  UNMODIFIED. HMAC verification is byte-exact by construction; re-
  serializing the already-parsed JSON would not reliably match what Stripe
  actually signed.
- **Two idempotency layers — the SAME posture payroll.md documents for
  `PayrollRunLine`.** `IdempotencyService.execute('stripe-webhook',
event.id, fn)` (0.10, Redis) is the fast path; `BillingEvent`'s own
  `@@unique([tenantId, stripeEventId])` is the DB-level backstop — the
  FIRST write inside the tenant transaction
  (`StripeWebhookService.applyEvent`), so a redelivered event that somehow
  raced past the Redis claim (a TTL eviction, a process restart mid-flight)
  hits a `P2002` and is treated as "already processed", never
  double-applied — proven directly in the e2e suite by delivering the
  identical event twice and asserting exactly one `BillingEvent` row and
  exactly one matching `audit_log` entry exist afterward, not two.
- **Direct, precise auditing — NOT via `DomainEventAuditListener`.** Unlike
  every other domain-event namespace, `billing.*` is deliberately NOT added
  to `DomainEventAuditListener`'s `@OnEvent(...)` list. `StripeWebhookService`/
  `PlatformBillingService` write their own audit rows directly
  (`AuditRecordService.recordWithinTransaction`/`.recordForTenant`, real
  before/after Subscription or Invoice snapshots plus the triggering
  `stripeEventId`) — richer and more precise than the generic
  namespace-derived entity-type/id guess that listener does for every other
  namespace, and it avoids a duplicate, less-detailed second audit row for
  the same action. This mirrors the newer, more explicit pattern
  `PlatformTenantService` (4.1) already established over
  `LicensingAdminService`'s older generic-event-only one.
- **Handled event types**: `customer.subscription.created`/`.updated`/
  `.deleted`, `invoice.created`/`.finalized`/`.paid`/`.payment_failed`/
  `.voided`, `payment_method.attached`/`.updated`/`.detached`.
  `payment_method.detached`'s payload has NO `customer` field in real
  Stripe deliveries (the method is no longer attached to anyone by the time
  the event fires) — the one event type this system resolves by a
  different key, `PaymentMethod.stripePaymentMethodId`, not
  `Subscription.stripeCustomerId`. Every other event type is recorded (the
  `BillingEvent` marker still gets written) but otherwise a documented,
  logged no-op.

## 5. Money — Decimal end to end, proration preview vs. the authoritative charge

Every monetary column (`Invoice.amountDue`/`amountPaid`/`amountRemaining`)
is Postgres `Decimal` — the SAME rule payroll.md documents, reused
verbatim: NEVER a JS float. Stripe's own convention is integer MINOR units
(cents); `toDecimalFromMinorUnits` (`billing/money.util.ts`) is the ONE
place that conversion happens (`new Prisma.Decimal(minorUnits).dividedBy(100)`),
shared by the webhook sync path, `PlatformBillingService.createAmcInvoice`,
and the setup-fee charge.

**Two different numbers, two different jobs, deliberately not conflated:**

1. **The proration PREVIEW** (`proration.util.ts`'s
   `computeProrationPreviewMinorUnits`) — a pure, `Prisma.Decimal`-only
   function with its OWN unit-test file (`proration.util.spec.ts`, 6 tests,
   no Stripe/DB dependency at all — the SAME "pure function, its own
   `.spec.ts`" posture `payroll-variables.util.ts` already establishes),
   `(newMonthlyCharge - oldMonthlyCharge) * fractionOfPeriodRemaining`.
   Returned in `POST /billing/plan`'s response so the tenant portal can
   show a same-second estimate before a plan change is confirmed.
2. **The authoritative charge** — whatever Stripe itself computes and
   returns on the resulting invoice, recorded Decimal-correct by
   `StripeWebhookService.handleInvoiceEvent` when the `invoice.*` webhook
   arrives. The preview and the eventual real invoice amount CAN differ in
   a real deployment (Stripe's proration engine is more precise — exact
   calendar days, tax, multiple line items); this system never presents
   the preview as final, only as an estimate.

**Setup fee** (`BillingService.chargeSetupFeeIfApplicable`) fires ONCE, the
first time a tenant ever gets a real Stripe subscription (never on a later
plan change) — a one-off `Invoice` (`type: SETUP_FEE`), not a Subscription
line item. Best-effort ONLY around the Stripe API call itself (caught,
logged, the plan change proceeds regardless — nothing has touched Postgres
yet at that point, so there's nothing to roll back); the subsequent
`tx.invoice.create` deliberately is NOT wrapped the same way and is allowed
to propagate, since a failed statement inside a Postgres transaction aborts
every later statement in it regardless of whether the JS exception around
it was caught — swallowing that failure would be false safety.

## 6. AMC (annual maintenance) invoicing — the lifetime-tenant bridge

`PlatformBillingService.createAmcInvoice` (`platform/billing/`) —
`platform.billing.manage`-gated (PLATFORM_OWNER only, the same "real-money
control point, most tightly held" reasoning `TENANT_DELETE`/`ADMIN_MANAGE`
already document for themselves). Invoice-only: `stripeClient.invoices.create`
with NO subscription involved, `Invoice.subscriptionId: null`,
`type: 'AMC'`. Works for any tenant — the named consumer is a lifetime/
on-prem tenant who otherwise never touches Stripe at all, but nothing
prevents invoicing a SaaS tenant for a one-off charge the same way.
Dual-audited exactly like tenant lifecycle actions (4.1's
`PlatformTenantService.recordTenantAudit` pattern): the target tenant's own
`audit_log` AND `PlatformAuditLog`, both carrying the real
`platformAdminId` — unlike `billing.*`'s webhook-driven events (no human
actor to attach), this one has a real platform admin at the call site, so
it's threaded through explicitly rather than left to the
`actorPlatform: true` generic fallback.

## 7. Vendor console + tenant portal surfaces

- **`apps/portal`'s `/billing`** (`billing.manage`-gated, TENANT_ADMIN
  only — ownership/money territory, the SAME reasoning `license.manage`/
  `audit.read` already document for themselves, deliberately NOT copied
  into `HR_MANAGER`'s permission list): current plan/status/seats, a plan
  changer showing the proration preview, payment methods, invoices.
  **Payment method collection is deliberately NOT a full Stripe Elements/
  Checkout integration** — this reference implementation exposes a plain
  "payment method token" text field (`POST /billing/setup-intent` exists
  for a REAL integration to build a card form against, but the shipped UI
  just accepts a `pm_...` id directly, e.g. Stripe's own well-known test
  token `pm_card_visa`) — the SAME "functional over fancy" posture 4.1's
  raw-JSON country-pack editor already takes for an internal/reference
  surface; wiring a real `@stripe/stripe-js` card element is a natural,
  narrow follow-up, not attempted here since it needs a live Stripe
  publishable key this environment has no way to exercise.
- **`apps/admin`'s `/billing`** — a cross-tenant subscription overview
  (cheap indexed read, the SAME "never a per-tenant loop" posture 4.1's
  usage page already takes) plus, on each tenant's own detail page, a
  Billing card (plan/seats/invoices, a "Resync from Stripe" lever for the
  rare missed-webhook case, and the "New AMC invoice" action).
  `platform.billing.read` is granted to BOTH platform roles (PLATFORM_SUPPORT
  can see billing status while debugging); `platform.billing.manage`
  (AMC invoicing, resync) is PLATFORM_OWNER-only, hidden from the UI for
  PLATFORM_SUPPORT rather than merely blocked server-side — the same RBAC-
  hides-not-just-blocks posture 4.1 already established.

## 8. Security

Stripe secret keys are server-side only (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` — read only by `apps/api`, never sent to
`apps/portal`/`apps/admin`, never logged — `@hrm/shared`'s
`redactSensitiveFields`'s existing generic `secret` key-name match already
covers both). Webhook signature verification is mandatory — `StripeWebhookService.handleRawEvent`
throws `400` before touching the database if `STRIPE_WEBHOOK_SECRET` is
unset or the signature doesn't verify, proven directly in the e2e suite. No
raw card data ever reaches this backend — a `paymentMethodId` is a Stripe-
issued token produced client-side; `PaymentMethod` only ever stores the
non-sensitive display fields (`brand`/`last4`/`expMonth`/`expYear`) Stripe's
own API already returns unencrypted, so there is nothing here for
`EncryptionService` to protect, unlike bank details/salary (1.1). Billing
mutations are `@AuditLog`'d on the tenant-portal side
(`BillingController`) exactly like every other mutating route in this
codebase.

## Known, documented gaps for this phase

`RealStripeClient` is written against the real `stripe` v17 SDK and type-
checks cleanly, but is NOT exercised by this codebase's own test suite (no
live Stripe account exists in this environment) — `MockStripeClient` is
what every test runs against, per this step's own explicit brief. Proration
preview is an ESTIMATE (see §5) — Stripe's own real proration on the
eventual invoice is authoritative and can differ slightly. Payment-method
collection is a raw token field, not a real Stripe Elements card form (see
§7). `BillingSeatMeteringService`'s daily sync has no back-pressure/rate-
limit awareness of Stripe's own API limits beyond what `RealStripeClient`'s
underlying SDK already retries — fine at this system's current reference
scale, worth revisiting if a deployment ever has thousands of tenants
syncing on the same cron tick. A `billing.subscription_activated`/etc.
event's fire-and-forget notification dispatch landing after a test's own
`afterAll` has deleted its tenant fixture can log a caught foreign-key
error — the SAME benign, non-failing test-teardown-ordering artifact
notifications-queues.md already documents for `workflow.submitted`, not a
new issue. Multi-currency conversion for reporting (rolling a tenant's
invoices up into `Tenant.baseCurrencyCode`, the way payroll's
`MultiCurrencyRollupService` does) is not attempted — each invoice is
stored and displayed in whatever currency Stripe actually billed it in.

Verified end-to-end over real HTTP by `apps/api/test/billing.e2e-spec.ts`
(18 tests: `billing.manage` deny-by-default; seat metering reflecting the
live active-user count; a plan upgrade/downgrade computing a Decimal-safe
proration preview, including a correctly NEGATIVE credit on a downgrade;
signature verification rejecting a bad delivery; an unmatched Stripe
customer acknowledged and platform-audited rather than crashing;
`customer.subscription.updated` (active) being the REAL entitlement source
end to end — PROFESSIONAL flags resolving through the unmodified 0.6
resolution pipeline; a REDELIVERED webhook proven NOT to double-apply via
both the `BillingEvent` and `audit_log` row counts; PAST_DUE disabling
gated features without suspending the tenant; a fully canceled subscription
suspending the tenant — genuinely blocked, dual-audited; a multi-currency
(`eur`) invoice recorded Decimal-correct; the vendor console's read/manage
RBAC split including AMC invoicing never touching the `licenses` table; and
cross-tenant isolation for both interactive plan changes and inbound
webhooks) plus `apps/api/src/billing/proration.util.spec.ts` (6 pure-
function unit tests). `apps/api`'s full suite: **447 tests green** (423
existing + 6 new unit + 18 new e2e), zero regressions. Full-repo `pnpm
build`/`pnpm lint` green across all 8 workspace tasks. `apps/portal`'s
existing 76-test Playwright suite and `apps/admin`'s existing Playwright
suite both verified green, untouched by this step (new `/billing` pages
added to both apps' navigation with no new Playwright coverage written for
them in this pass — the task's own test list is backend-e2e-focused; a
natural follow-up).
