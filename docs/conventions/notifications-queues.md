# Notifications hub

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.8 — `packages/db`, `packages/shared`,
`apps/api/src/notifications`, `apps/api/src/queue`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.8 notifications hub" entry)
for the full file list and verification notes. This is the delivery layer
every domain event emitted since 0.4 (auth), 0.6 (licensing), and 0.7
(workflow) has been waiting for — none of those emitters changed to make
this work (beyond auth's password-reset event gaining a `token` field, see
below); this hub just started listening to the SAME `auth.*`/`licensing.*`/
`workflow.*` events `AuditEventsListener`/`LicensingEventsListener`/
`WorkflowEventsListener` already consumed.

- **Core model, echoing 0.7's logical/per-unit-of-work split** (see
  [workflow.md](./workflow.md) → Core model): `Notification` (one row per
  notification generated for one recipient from one domain event —
  channel-agnostic, holds the triggering event's `payload` for
  re-rendering) → `NotificationDelivery` (one row per CHANNEL that
  notification goes out on — `PENDING`/`SENT`/`FAILED`/`DEAD_LETTER`,
  `attempts`/`lastError`, `renderedSubject`/`renderedBody` captured at
  send time, `readAt` meaningful only for `IN_APP`). Both tenant-scoped,
  ordinary RLS. `NotificationPreference` (tenant-scoped,
  `@@unique([tenantId, userId, eventType, channel])`) is the per-user
  opt-in/opt-out layer. `NotificationTemplate` is deliberately NOT
  tenant-scoped — global, versioned, `isActive` vendor copy keyed by
  `(eventType, channel, locale, version)`, the exact same RLS-exempt
  "system-owned reference data" shape as `CountryPack` (0.5, see
  [country-packs.md](./country-packs.md)), for the same reason (it's
  vendor-authored, not per-tenant).
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
  0.10's circuit breaker wraps the per-channel `.send()` call inside this
  method (see [resilience.md](./resilience.md) → Circuit breakers) — a
  `CircuitOpenError` flows into this same retry/dead-letter handling as
  any other send failure, no special-casing needed.
- **Provider seam — swappable per channel, same shape as 0.4's SSO
  seam** (see [auth-rbac.md](./auth-rbac.md) → SSO seam). `NotificationProvider`
  (`@hrm/shared`, `send(params):
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
  SMS still has no real destination field on `User` (no phone number —
  that belongs to a future Employee/profile module); its dev provider
  logs the recipient's userId as a placeholder `to`. **PUSH gained a real
  destination in step 1.4**: `User.pushToken` (nullable, set/cleared via
  `POST /auth/push-token`, registered by the mobile app on login/logout —
  see [frontend-ess-mss.md](./frontend-ess-mss.md)) — `NotificationDeliveryService`
  now uses it as `to` when present, falling back to the same userId
  placeholder otherwise. `LogPushProvider` itself is UNCHANGED (still only
  logs) — this only wires the REGISTRATION half for real; a genuine
  FCM/Expo-push-API-calling provider is still future work, one DI binding
  away.
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
  silently blank notification. This `{{placeholder}}` substitution
  mechanism was later promoted to `@hrm/shared` in 0.9 so both this
  catalog and the web apps' UI-string catalog share one templating
  syntax — see [i18n-timezone-rtl.md](./i18n-timezone-rtl.md) → String
  externalization.
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
  `WorkflowEscalationService` already established in 0.7 — see
  [workflow.md](./workflow.md)). The two small lookup queries are
  duplicated with an explicit-`tx` signature rather than touching
  `country-packs/`; the actual pack/override MERGE logic
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

  **Forward-looking note (not built, flagged during Phase 0 for a later
  phase): the transactional-outbox pattern is the eventual, more robust
  upgrade to this retry.** The bounded retry above is a mitigation, not a
  fix — it narrows the race window statistically but doesn't close it,
  and a sufficiently slow or long-running source transaction could still
  exhaust all five retries and silently drop recipients. A transactional
  outbox would close it structurally: instead of emitting
  `eventEmitter.emit(...)` synchronously from inside the source
  transaction, the emitting code would write an `outbox` row in the SAME
  transaction as the domain mutation (so it's guaranteed to exist if and
  only if the mutation committed), and a separate poller/relay process
  would read committed outbox rows and dispatch them — eliminating the
  race entirely rather than retrying around it, at the cost of at-least-
  once delivery semantics and a small dispatch-latency floor (the
  poller's interval). Deferred because the bounded retry already resolves
  the race in practice for this system's actual transaction sizes, and a
  real outbox needs its own table, poller/worker, and idempotent-consumer
  discipline on every listener — worth building if/when a phase's
  transactions grow large enough (e.g. a bulk payroll run) that the
  bounded retry's ~2 second ceiling stops being enough.

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
  log (see [audit-custom-fields.md](./audit-custom-fields.md)), not a gap
  introduced silently.
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
  `Department.headUserId` (see [workflow.md](./workflow.md)).
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
