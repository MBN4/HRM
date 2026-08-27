# Resilience chassis

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.10 — `packages/db`, `packages/shared`,
`apps/api/src/resilience`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"0.10 resilience chassis" entry) for the full file list and verification
notes. "Degrades gracefully, never collapses" — the honest framing per this
step's own brief is GRACEFUL DEGRADATION + FAULT ISOLATION, not
"unbreakable". Every Phase 1+ module inherits this automatically: nothing
here is opt-in per route except the two decorator-driven pieces
(`@Priority()`, `@Idempotent()`) that need per-route intent.

- **THE SPINE IS ONE INTERCEPTOR, NOT SEVERAL, AND THIS IS LOAD-BEARING.**
  `TenantScopeInterceptor` (0.3, extended by 0.4 for auth — see
  [tenant-resolution.md](./tenant-resolution.md),
  [auth-rbac.md](./auth-rbac.md)) now ALSO does load shedding, the
  request timeout, and per-tenant rate limiting — directly, as plain
  method calls, not as separate global `APP_INTERCEPTOR`s. This was NOT
  the original design: an earlier version registered
  `RequestTimeoutInterceptor`/`LoadSheddingInterceptor` as their own
  global interceptors in a separate `ResilienceModule`, relying on
  `AppModule` importing that module BEFORE `TenancyModule` to make them
  wrap `TenantScopeInterceptor`. **This was empirically PROVEN WRONG** by
  `apps/api/test/resilience.e2e-spec.ts`'s ordering test: NestJS does NOT
  reliably order `APP_INTERCEPTOR`s registered in DIFFERENT modules by
  `imports` array position — the separately registered interceptor ended
  up NESTED INSIDE `TenantScopeInterceptor` instead of wrapping it, so a
  "shed" request still paid for tenant resolution before ever reaching
  the shedding check. The fix, and the durable lesson: call cross-cutting
  per-request logic DIRECTLY from `TenantScopeInterceptor` (or a service
  it calls synchronously in its own method body) whenever ordering
  relative to tenant resolution/the DB transaction matters — never assume
  a second global `APP_INTERCEPTOR` will land in the right place relative
  to it. Order, every request:
  1. **Load shedding** (`LoadSheddingService.admit`) — the very first
     thing, before even `@Public()`/`@PlatformRoute()` detection. A shed
     request never resolves a tenant, never opens a transaction.
  2. The **request timeout** wraps everything from here down (`Promise.race`
     against a timer, converted back to an Observable at the very end).
  3. `@Public()`/`@PlatformRoute()` branch, unchanged from 0.3/0.4.
  4. Tenant resolution (0.3). Unresolvable -> 401.
  5. **Per-tenant rate limiting** (`TenantRateLimitService.enforce`) —
     still BEFORE `withTenantContext` opens the transaction, so an
     over-quota tenant never checks out a pooled DB connection.
  6. `withTenantContext` + auth (0.3/0.4), unchanged.
- **Per-tenant rate limiting.** Redis fixed-window counter (reusing
  0.4's `RateLimiterService` algorithm — promoted from `auth/` into the
  now-`@Global()` `RedisModule`, since it's a generic Redis primitive,
  not an auth-specific one, and `TenantScopeInterceptor` needed it too;
  no behavior change for existing auth callers). Limit/window resolved
  by `TenantRateLimitService`: an explicit per-tenant Redis-only
  override (`PATCH`/`GET`/`DELETE /platform/rate-limits/:tenantId`, a
  `@PlatformRoute()` admin lever shaped exactly like 0.6's
  `LicensingAdminController` — see
  [licensing-feature-flags.md](./licensing-feature-flags.md)) always
  wins; otherwise `@hrm/shared`'s `DEFAULT_RATE_LIMITS[Tenant.edition]` —
  deliberately `Tenant.edition`, NOT `Subscription.edition` (unlike 0.6's
  SaaS feature-flag resolution): bare request-volume throttling isn't a
  billing/entitlement concern, and `Tenant.edition` is always populated
  on every tenant regardless of whether a `Subscription` row exists.
  The resolved effective limit is cached in Redis for 30s (a deliberate,
  BOUNDED-staleness tradeoff — unlike 0.6's lifetime-license resolution,
  which must be fresh every call for security reasons, a rate limit
  briefly using yesterday's edition is not a security issue) so the hot
  path costs one Redis round trip per request, not a Postgres read;
  an override write invalidates the cache immediately. Every 429 now
  carries a real `Retry-After` header — `RateLimitExceptionFilter`
  (`APP_FILTER`) sets it from `TooManyAttemptsException.retryAfterSeconds`,
  which existed since 0.4 but had nowhere to put itself before this
  filter existed; this is a retroactive fix for the auth endpoints too,
  with no call-site change.

  **Forward-looking note (not built, flagged during Phase 0 for a later
  phase): fixed-window is a known-imprecise boundary, sliding-window/
  token-bucket are the stricter alternatives.** A fixed-window counter
  (`INCR` + `EXPIRE` on a window-aligned key) has a well-known boundary-
  burst weakness: a tenant can send up to ~2x its nominal limit across a
  window boundary (e.g. its full quota in the last second of one window,
  then its full quota again in the first second of the next), since the
  two windows are counted independently with no memory of each other.
  This was a deliberate simplicity tradeoff for this step, not an
  oversight — the threat model this rate limiter defends against is a
  runaway or bad-actor tenant consuming disproportionate shared capacity,
  not tight per-second fairness, and a fixed window is trivial to reason
  about and test. A sliding-window LOG (store every request timestamp,
  count how many fall in the trailing window) is exact but costs O(limit)
  memory per key; a sliding-window COUNTER (weighted average of the
  current and previous fixed windows) or a token-bucket (continuous
  refill rate, allows controlled bursts up to a bucket size) both close
  most of the boundary gap at roughly the same O(1) Redis cost as the
  current implementation. Worth upgrading if a real tenant is ever
  observed exploiting the boundary in practice, or if a stricter SLA
  requires it — the swap is localized to `TenantRateLimitService`'s
  internals (and `RateLimiterService`'s, since auth reuses the same
  algorithm), not the `@PlatformRoute()` override surface or the
  `Retry-After` contract callers see.

- **Circuit breakers.** `CircuitBreakerService` — Redis-backed (state:
  `state`/`failures`/`opened-at`, so every API instance shares one
  breaker per `name`, the same statelessness posture as
  `RateLimiterService`), generic: `execute(name, fn, options)`. State
  machine: `CLOSED` -(>= `failureThreshold` failures within
  `windowSeconds`)-> `OPEN` (every call fails fast via `CircuitOpenError`,
  NO attempt made) -(`resetTimeoutSeconds` later)-> `HALF_OPEN` (one
  best-effort-gated trial call let through — a short Redis lock narrows
  but doesn't eliminate a cross-instance race here, a documented,
  accepted simplification) -> success resets to `CLOSED`, failure trips
  straight back to `OPEN`. Each call is ALSO wrapped in a `timeoutMs`
  (`Promise.race`), so a hanging dependency counts as a failure the same
  as a thrown error. Wired onto 0.8's notification providers (see
  [notifications-queues.md](./notifications-queues.md)) —
  `NotificationDeliveryService`'s `.send()` call now runs through
  `circuitBreaker.execute('notification-provider:<channel>', ...)`, one
  breaker PER CHANNEL (EMAIL/SMS/PUSH) so one channel's provider
  tripping never affects the others; a `CircuitOpenError` flows into the
  SAME retry/dead-letter handling as any other send failure — no
  special-casing needed. Reference/proof surface (no real HTTP egress
  exists elsewhere yet to exercise a breaker against):
  `GET /resilience/demo/breaker` + `POST /resilience/demo/flaky/configure`
  (`FlakyDependencyService`, test/demo-only fault injection).
- **Load shedding.** `LoadSheddingService.admit(priority, response)`,
  called directly from `TenantScopeInterceptor` (see above for why it's
  not a separate interceptor). The "under stress" signal is
  DELIBERATELY simple: `SystemLoadService`'s in-flight-request counter
  against a threshold — not real event-loop-lag measurement, simple and
  deterministic to test; a more precise signal is a reasonable future
  enhancement, not built here. `SystemLoadService` is the ONE
  deliberate, documented exception to this step's "state in Redis"
  default: load shedding protects THIS PROCESS's own resources, which
  is inherently a per-instance concern — coordinating "am I busy?"
  through Redis would add a round trip to every request to ask a
  question only the local process can answer about itself.
  `@Priority('CRITICAL' | 'NORMAL' | 'LOW')` (default `NORMAL` when
  unmarked) classifies a route; `CRITICAL` is NEVER shed at any load —
  applied to `/health`, `/health/live`, `/health/ready`,
  `POST /auth/login`, `POST /auth/refresh`. `LOW` sheds first (default
  threshold 20 in-flight), `NORMAL` sheds only under heavier load
  (default 100) — both configurable
  (`LOAD_SHED_LOW_THRESHOLD`/`LOAD_SHED_NORMAL_THRESHOLD`). Shed
  responses are `503` with `Retry-After` set.
- **Connection-pool protection — the direct fix for 0.3's flagged
  tradeoff** (see [tenant-resolution.md](./tenant-resolution.md) → "The
  whole rest of the request runs inside one transaction"). `packages/db/src/pool-config.ts`:
  `appPrisma` (every tenant-scoped request — the client
  `TenantScopeInterceptor`'s held-open-transaction tradeoff actually
  stresses) and `prisma` (owner role — migrations/seeding/platform-admin/
  tests) get SEPARATE, independently-sized bounded pools
  (`DB_POOL_SIZE`/`DB_ADMIN_POOL_SIZE`, default 10/5) plus a shared
  `DB_POOL_TIMEOUT_SECONDS` (default 5) — Prisma's `pool_timeout` query
  param, appended to each client's own connection URL via
  `withPoolParams`. Exhaustion FAILS FAST instead of queueing
  indefinitely: Prisma throws `PrismaClientKnownRequestError` code
  `P2024` once `pool_timeout` elapses waiting for a free connection;
  `DbPoolExhaustionFilter` (`APP_FILTER`, extends `BaseExceptionFilter`
  and delegates via `super.catch()` for any OTHER Prisma error code —
  never re-throws from inside `catch()`, which Nest doesn't cleanly
  re-route) catches SPECIFICALLY that code and turns it into a clean
  `503` with `Retry-After`. Full PgBouncer/read replicas are Phase 5.1 —
  this step only protects against exhaustion within a single Postgres
  connection budget, as scoped.
- **Idempotency.** `IdempotencyService.execute(scope, idempotencyKey, fn)`
  — Redis-backed, the standard "claim, then cache the outcome" shape
  (the same one most real idempotency-key implementations, e.g.
  Stripe's, use): `SET key IN_PROGRESS NX` claims it; the winner runs
  `fn()` and on success overwrites the key with `{status: COMPLETED,
result}` (a FAILED attempt DELETES the key instead — only a recorded
  SUCCESS should ever be replayed, a failure must not poison future
  retries); a caller who loses the claim gets the cached result back if
  `COMPLETED`, or a `409 Conflict` if still `IN_PROGRESS` (a genuinely
  concurrent duplicate — simpler than blocking/polling, correct for the
  common "client retried after a timeout" case). Reusable via
  `@Idempotent()` + `@UseInterceptors(IdempotencyInterceptor)` (same
  "decorator carries metadata, route-scoped interceptor does the work"
  shape as `@AuditLog()`/`AuditInterceptor` — see
  [audit-custom-fields.md](./audit-custom-fields.md)) — requires an
  `Idempotency-Key` header (`400` if missing), scopes the key PER TENANT
  (`TenantContextService.tenantId`, falling back to `"platform"`).
  Earmarked for payroll/billing mutations later, per this step's brief;
  proven today via `POST /resilience/demo/idempotent`. HONEST
  LIMITATION, documented at `IdempotencyService`: the `COMPLETED` marker
  is written once the handler function RETURNS, which for a route
  running inside `TenantScopeInterceptor`'s held-open transaction is a
  narrow window before that transaction actually COMMITs — a same-request
  commit failure in that window could leave Redis believing a write
  succeeded that Postgres never durably applied. Closing this fully
  would need cross-store two-phase coordination, out of scope; this is
  the same tradeoff most production idempotency-key implementations
  accept.
- **Graceful degradation + health.** `GET /health` (0.3, unchanged) and
  the new `GET /health/live` are bare liveness (process is up, no
  dependency checks). `GET /health/ready` (`ReadinessService`) is REAL
  readiness: Postgres reachable (`prisma.$queryRaw\`SELECT 1\`` — the
OWNER client with no tenant context, since this is an infrastructure
probe, not a tenant query), Redis reachable (`PING`), AND the process
isn't mid-shutdown — `503`if any of the three is false, with which
one(s) visible in the response body. **Graceful shutdown is
readiness-driven, not`enableShutdownHooks()`'s default behavior**:
`main.ts`handles`SIGTERM`/`SIGINT`itself —`ShutdownService.beginShutdown()`flips`/health/ready`unhealthy IMMEDIATELY (so an orchestrator's load
balancer stops routing new traffic here), THEN waits`SHUTDOWN_GRACE_PERIOD_MS`(default 5000ms, long enough for a health
check interval to notice) BEFORE calling`app.close()`, which drains
in-flight requests (Node's `server.close()`semantics) and runs every
module's own`onModuleDestroy`/`onApplicationShutdown`(DB pools,
Redis, BullMQ workers). Using the default`enableShutdownHooks()`instead would call`close()` immediately with no gap for a load
balancer to react — the explicit handler exists specifically to
create that gap. **Inbound request timeout**: see "THE SPINE" above —
a hard ceiling (`REQUEST_TIMEOUT_MS`, default 30000ms) on total
request time, HONESTLY documented as bounding CALLER wait time, not
underlying work duration (JS Promises aren't cancellable — an
orphaned `pg_sleep`/query keeps running server-side until it finishes
naturally or hits its own `pool_timeout`).
- **Stateless by design**, per this step's explicit instruction: every
  piece of cross-request state lives in Redis (rate-limit counters/
  overrides/cache, circuit-breaker state, idempotency records) with the
  ONE deliberate, documented exception (`SystemLoadService`'s in-flight
  counter — see Load shedding above) — this is what lets Phase 5.3's
  horizontal scaling "just work" against this chassis with no further
  changes needed here.
- Verified end-to-end over real HTTP by three e2e files (kept SEPARATE
  specifically where a file needs to force `process.env` before
  `@hrm/db`/`AppModule` import, since jest gives each e2e file its own
  worker process but env vars are otherwise process-global — mixing
  incompatible timing budgets in one file was tried and caused real
  failures during development, see each file's own header comment):
  `apps/api/test/resilience.e2e-spec.ts` (10 tests — per-tenant rate
  limiting isolating tenant A's 429 from tenant B; the circuit breaker
  tripping, failing fast, and recovering via a HALF_OPEN trial;
  idempotency replay/concurrent-409/per-tenant scoping; readiness
  reflecting health and flipping to 503 the instant shutdown begins;
  load shedding never affecting CRITICAL routes and — via a
  deterministically-driven `SystemLoadService` rather than racy real
  concurrency — proving a shed request never reaches tenant resolution
  by getting 503 instead of the 401 an unresolvable Host would
  otherwise produce), `apps/api/test/resilience-pool-exhaustion.e2e-spec.ts`
  (a contender request against a deliberately 1-connection pool gets a
  clean 503; the holder still succeeds — required a pool "warm-up"
  request in `beforeAll` and forcing the holder request to dispatch
  immediately via `.then((r) => r)`, since supertest/superagent
  `Request` objects are LAZY thenables that don't actually send until
  awaited/thenned, a real bug caught while writing this test), and
  `apps/api/test/resilience-request-timeout.e2e-spec.ts` (a handler
  exceeding `REQUEST_TIMEOUT_MS` gets a clean 408 well before the
  underlying 5s `pg_sleep` finishes; an ordinary fast request is
  unaffected).
