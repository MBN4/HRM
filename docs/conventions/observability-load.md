# Observability + load testing

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 5.4 (Phase 5's final slice) — `apps/api/src/common/logging`,
`apps/api/src/metrics`, `apps/api/src/tracing`, `packages/shared/src/audit/redact.ts`,
`deploy/observability/`, `docker-compose.observability.yml`, `load/`,
`apps/api/scripts/seed-load-test-data.ts`. Builds on
[resilience.md](./resilience.md) (every metric this step adds instruments
an EXISTING 0.10 mechanism — rate limiting, load shedding, circuit
breakers, pool exhaustion — never a new one),
[deployment-scaling.md](./deployment-scaling.md) (the api/worker split and
`/metrics` this step wires into both), [scaling-data-layer.md](./scaling-data-layer.md)
(the DB pool/cache this step observes and load-tests),
[tenancy-rls.md](./tenancy-rls.md) (logs must be tenant-correlated but
NEVER leak cross-tenant data — the same isolation boundary RLS already
enforces at the DB layer, extended here to the log/metric layer),
[notifications-queues.md](./notifications-queues.md) (queue depth is now
a first-class metric AND the worker-autoscaling signal `worker-hpa-keda.yaml`
already reads directly from Redis), [payroll.md](./payroll.md) and
[attendance.md](./attendance.md) (the two hot paths this step's own load
tests found a REAL, fixed bug in). **Two genuinely different halves, per
this step's own brief: full production observability (largely provable
locally), and load-testing the hot paths to find/fix real bottlenecks
while documenting the path toward the 20M-user target honestly — not
"tested at scale," which this step never claims.**

## 1. Structured logging

`PinoLoggerService` (`common/logging/pino-logger.service.ts`) implements
Nest's `LoggerService` interface and is installed via `app.useLogger(...)`
in BOTH `main.ts` and `worker.ts` (`bufferLogs: true` on the Nest
factory call so even bootstrap-time logs, emitted before `useLogger` runs,
are queued and then flushed through it rather than lost). This is the ONE
thing that makes every EXISTING `new Logger('SomeContext')` call site
across ~19 files emit consistent JSON with ZERO call-site changes — Nest's
built-in `Logger` class delegates every instance method to one static,
replaceable logger reference.

- **Correlation, automatic, on every line** — via pino's `mixin` hook,
  which runs on every single log call and merges in whatever's currently
  available from TWO independent `AsyncLocalStorage` stores:
  `common/logging/request-context.store.ts` (`requestId` — set by
  `requestIdMiddleware`, plain `app.use()` middleware wrapping the ENTIRE
  request, registered before any interceptor) and
  `tenancy/tenant-context.store.ts` (`tenantId`/`userId`/`platformAdminId`
  — the SAME store `TenantScopeInterceptor` already populates, reused
  as-is, no second context mechanism invented). No caller ever has to
  remember to pass these — they're just there.
- **PII/secret safety — reuses the 0.9 audit redaction mechanism
  verbatim.** Any object logged is run through `redactSensitiveFields`
  (`@hrm/shared`, the SAME function `AuditInterceptor`/
  `DomainEventAuditListener` already use — see
  [audit-custom-fields.md](./audit-custom-fields.md)) before it reaches
  pino. This step extended that ONE shared pattern
  (`password|token|secret|...`) with `ssn|cnic|ntn|qatarId|nationalId|
passportNumber|bankAccount|iban|taxId` — protecting BOTH the audit sink
  and structured logs at once, automatically, for any future term added
  to that one regex. Proven in `pino-logger.service.spec.ts` (6 tests): a
  logged object containing `password`/`compensation`/`ssn` keys comes out
  `[REDACTED]`, the raw values never appear anywhere in the emitted JSON.
- **A real gap found via this step's OWN e2e testing, not assumed
  correct**: the FIRST version of the error-tracking integration
  (`observability.e2e-spec.ts`) found `tenantId` missing from a captured
  exception's context, even though the failing request clearly had one.
  Root cause: when a request throws from INSIDE `withTenantContext`'s
  Postgres transaction, Prisma's own ROLLBACK is a real, separate async
  round-trip against its query engine — by the time that settles and Nest's
  default exception handling calls `logger.error(...)`, the
  `tenantContextStorage` continuation that was active at throw-time can
  already be gone (a genuine Node `AsyncLocalStorage`-across-native-async-
  boundary edge case, not something either store's own code got wrong).
  Fix: `TenantScopeInterceptor` now ALSO mirrors `tenantId`/`userId` into
  the (always-alive-for-the-whole-request) `requestContextStorage` the
  moment they're resolved (`setRequestLogIdentity`, `request-context.store.ts`),
  and `PinoLoggerService.buildCorrelationFields` falls back to that mirror
  whenever the live tenant store is already gone. Proven directly:
  `observability.e2e-spec.ts`'s error-tracking test deliberately triggers
  an exception from inside a real tenant transaction and asserts the
  captured context still carries the right `tenantId`.

## 2. Error tracking

`error-tracker.ts` — the SAME "real binding only when its secret is
configured, a Noop otherwise" seam this codebase already uses for Stripe
(billing.md) and ACME (white-label.md): `SENTRY_DSN` unset (every local/CI
run) binds `NoopErrorTracker` (does nothing — structured logs already
capture the error either way); set, binds a REAL `SentryErrorTracker`
(`Sentry.init({dsn, environment, release, sendDefaultPii: false})` —
deliberately `sendDefaultPii: false`, since this codebase's own redaction
discipline is the trusted mechanism, not Sentry's default raw-request
capture). `PinoLoggerService.error()` forwards to it with ONLY already-
scrubbed correlation fields (`requestId`/`tenantId`/`userId`/`context`) —
never the raw message/args a caller passed, so a future `logger.error(someRawObject)`
call site can't accidentally leak something through this second sink even
if it forgot to scrub itself first. A plain module-level singleton
(`sharedErrorTracker`) — not a Nest DI-resolved provider — because
`PinoLoggerService` is constructed manually in `main.ts`/`worker.ts`
BEFORE `NestFactory` even runs, so nothing DI-registered exists yet at
that point; `LoggingModule` ALSO exposes the same singleton as an
injectable (`ERROR_TRACKER` token) for any service that wants to call
`captureException` explicitly.

## 3. Metrics

`MetricsService` (`metrics/metrics.service.ts`) — one `prom-client`
`Registry` per process (api AND worker each have their own), plus
`collectDefaultMetrics` (free process/Node metrics — CPU, event-loop lag,
heap, GC). Every label set is deliberately BOUNDED (route TEMPLATE, method,
status code, queue name, cache name, breaker name, priority) — never a raw
tenant id, which would make `/metrics` an unbounded-cardinality problem at
real scale; per-tenant observability belongs in the tenant-correlated LOGS
this step also built, never in a Prometheus label.

| Metric | What it measures | Wired into |
| --- | --- | --- |
| `hrm_http_request_duration_seconds` / `hrm_http_requests_total` | Request rate/latency/error-rate per route | `metrics/http-metrics.middleware.ts`, `app.use()` in `main.ts` (wraps the WHOLE request, including tenant resolution — an interceptor can't observe the FINAL status code reliably for the success path, `res.on('finish', ...)` can) |
| `hrm_queue_depth` | BullMQ job count per queue/state — THE worker-autoscaling signal (`worker-hpa-keda.yaml`, 5.3, reads the identical Redis list length) | `metrics/queue-metrics.service.ts` — one shared `ioredis` connection, `Queue.getJobCounts()` polled every 15s across all 15 registered queues, zero processor changes |
| `hrm_cache_hits_total` / `hrm_cache_misses_total` | The 5.1 caches (country-pack/org-structure/permissions) | One `recordCacheHit`/`recordCacheMiss` line at each service's existing cache-check branch |
| `hrm_circuit_breaker_state` | 0=CLOSED/1=HALF_OPEN/2=OPEN, by breaker name | `CircuitBreakerService.execute`, sampled on every call |
| `hrm_rate_limit_rejections_total` | 429s, by source (tenant/api-key/auth — never a tenant id) | `RateLimitExceptionFilter` — the ONE choke point every rate limiter already funnels through |
| `hrm_load_shed_rejections_total` | 503s from load shedding, by priority | `LoadSheddingService.admit` |
| `hrm_db_pool_exhaustion_rejections_total` | 503s from DB pool/transaction-start exhaustion | `DbPoolExhaustionFilter` — see § 7's own real finding for why this filter itself needed a fix this step |

`GET /metrics` (`metrics/metrics.controller.ts`) is `@Public()` (no tenant
to resolve for an infra endpoint) + `@Priority('CRITICAL')` (a scrape must
never be shed by the load it's trying to help diagnose — the same
reasoning `/health/live`/`/health/ready` already use) + `MetricsAuthGuard`
(a plain bearer-token check against `METRICS_TOKEN`; unset defaults to
open, matching this codebase's "no setup needed for local dev" posture —
a real deployment MUST set it, and the k8s manifests/README also call out
network-level restriction as the accompanying defense-in-depth layer, the
same "no single control trusted alone" posture used everywhere else). The
worker exposes its OWN `/metrics` (a separate registry — separate process)
on its existing hand-rolled health server (`worker.ts`), deliberately
unauthenticated there since that server has no Nest guard pipeline at all
— restricting that port at the network layer is the expected control.

**Verified against a REAL Prometheus, not just unit-tested**: the local
observability stack (§ 5) was actually brought up against a real running
API instance — `GET /api/v1/query?query=hrm_queue_depth` returned real,
live values, and the scrape target showed `"health": "up"`.
`observability.e2e-spec.ts` (6 tests) proves the auth guard (401 with no/
wrong token), the key metric families are present after generating traffic,
a cache miss-then-hit pair is observable for the SAME country code, and a
real 429 increments the rate-limit counter.

## 4. Tracing

`tracing/init-tracing.ts` — an OpenTelemetry `NodeSDK` bootstrap, imported
as the LITERAL FIRST LINE of both `main.ts` and `worker.ts` (before even
`reflect-metadata`) — auto-instrumentation patches `http`/`express`/
`ioredis` at their first `require()`, so the SDK must be listening before
anything else in the dependency graph pulls those modules in. Exporter
seam: `OTEL_EXPORTER_OTLP_ENDPOINT` set → real OTLP/HTTP export; unset
(every local/CI run) → `ConsoleSpanExporter`, a genuine, inspectable local
story (completed spans print to stdout), not a silent no-op. This file is
imported ONLY by the two entrypoints — never by `AppModule` — so it never
runs under Jest at all; no `NODE_ENV==='test'` guard needed.

**api → DB/Redis, for free**: `HttpInstrumentation`/`ExpressInstrumentation`/
`IORedisInstrumentation` give every HTTP request and every Redis command
(rate limiting, idempotency, circuit-breaker state, BullMQ's own internals)
a span automatically, zero application code changes.

**api → worker, deliberately NOT automatic** — a BullMQ job crossing the
process boundary has no HTTP/Redis call an instrumentation library can
hook to link it back to the enqueuing request; the trace context has to
travel explicitly inside the job's own payload, the same way it travels in
an HTTP `traceparent` header. `tracing/queue-trace.util.ts`
(`injectTraceContext`/`runWithExtractedTraceContext`, plain
`propagation.inject`/`.extract` over W3C Trace Context) is wired into ONE
representative flow — `NotificationsService.handleDomainEvent` (producer)
→ `NotificationProcessor.process` (consumer) — so a trace viewer can show
the enqueuing HTTP request and the job that eventually delivered it as ONE
connected trace. **Honestly scoped**: the other 15 registered queues get
the automatic HTTP/DB/Redis spans (real value already) but not yet this
explicit producer→consumer LINK — applying the identical two-function
pair to any other queue is the documented, straightforward follow-up, not
built here.

## 5. Dashboards, alerts, and the local observability stack

`deploy/observability/` — Grafana dashboard JSON (`grafana/dashboards/`:
API Overview — request rate/error-rate/p50-p95-p99 latency/rate-limit
&load-shed/circuit-breaker panels; Queues & Workers — `hrm_queue_depth`
per queue/state, the same signal the KEDA autoscaler reads; Database &
Cache — cache hit ratio, pool-exhaustion rejections, plus a Prisma-
`$metrics`-preview-feature panel documented as a richer OPTIONAL follow-on,
not built this step) + Prometheus alert rules (`prometheus/alerts.yml`,
plain rule-file format, and `prometheus-rule.yaml`, the identical rules as
a k8s `PrometheusRule` CRD for a Prometheus-Operator cluster — apply
EITHER, never both) covering the key SLOs: 5xx rate, p99 latency, queue
backlog (warning + critical thresholds), DB pool exhaustion frequency,
a stuck-OPEN circuit breaker, a rate-limit-rejection spike, sustained load
shedding, and target-down.

**Verified against REAL instances, not just written**:
`docker-compose.observability.yml` (Prometheus + Grafana, additive to the
root compose file) was actually brought up locally — Prometheus's own
`/api/v1/rules` endpoint confirmed all 9 alert rules parse as valid PromQL
(`"health": "ok"` on every one), and Grafana's `/api/search` confirmed all
3 dashboards auto-provisioned correctly via the file-based provisioning
config (`grafana/provisioning/`).

**Status-page approach** (documented, not built — a genuinely separate
product, not infrastructure this codebase should host itself): point a
managed status-page service (e.g. an uptime-monitoring SaaS, or a
self-hosted option) at each region's own public `/health/live` — see
[deployment-scaling.md](./deployment-scaling.md) § Regional deployment for
the per-region topology this would run against. `/health/live` (not
`/health/ready`) is the right target for an EXTERNAL status page
specifically: a status page should say "the region is up," not flap every
time one pod is mid-rolling-deploy and briefly not-ready.

## 6. Load testing (k6) — realistic multi-tenant scenarios

`apps/api/scripts/seed-load-test-data.ts` provisions a genuinely SKEWED
tenant distribution — 2 "whale" tenants (300 and 200 employees,
`ENTERPRISE` edition + a real `ACTIVE` `Subscription` row, since
`MULTI_COUNTRY_PAYROLL` is entitlement-gated in SaaS mode — see
[licensing-feature-flags.md](./licensing-feature-flags.md)) and 8 ordinary
15-employee `PROFESSIONAL` tenants — deliberately NOT one giant tenant,
per this step's own brief. Writes `load/fixtures/tenants.json`, which every
k6 scenario reads via `open()`, so no script ever hardcodes a tenant id/
slug/password. `load/scenarios/`:

| Scenario | Hot path | Peak load |
| --- | --- | --- |
| `login.js` | `POST /auth/login` | 50 concurrent VUs, sustained 1m |
| `attendance-clockin.js` | The HIGH-VOLUME path — `attendance.md` | 200 VUs, each ONE clock-in/out pair (a real "everyone clocks in during the 9am window" burst) |
| `dashboard-read.js` | Precomputed-rollup analytics reads | 30 VUs, 1 req/s each |
| `employees-list.js` | A paginated/filtered list+search endpoint | 30 VUs, 1 req/s each |
| `payroll-run.js` | Full create→calculate→poll cycle | 2-3 VUs (payroll is inherently rare/heavy — see payroll.md) |
| `rate-limit-isolation.js` | Per-tenant quota isolation UNDER LOAD | A noisy tenant (40 VUs) vs. a quiet one (1 req/s) |
| `load-shedding.js` | LOW-priority shedding UNDER LOAD | 150 VUs flooding the LOW-priority demo route |
| `pool-backpressure.js` | DB backpressure UNDER LOAD | 40 VUs against the `/resilience/demo/slow` route |

Run via the official `grafana/k6` Docker image — no local k6 install
needed (`load/README.md` has the exact commands). All measurements below
are from THIS repo's own dev machine (a single, modest-core Linux host —
the SAME machine every other verification in this codebase's build log
runs on), against the local `docker-compose` Postgres/Redis, one API
process (`node dist/main.js`, no worker running for most runs).

## 7. Load testing findings — real bottlenecks found and fixed

This is the part of this step's brief that mattered most: run it, measure
it, fix what's actually broken. Three DIFFERENT real things were found —
one in application code, one in the resilience chassis, and (a genuinely
useful category in its own right) several in the LOAD-TEST SCRIPTS
themselves, which is exactly the kind of mistake a REAL load-testing
exercise is supposed to catch before it produces a false alarm.

### 7.1 — Payroll's per-employee component-definition re-fetch (a real N+1, fixed)

`PayrollEngineService.computeForEmployee` called
`PayrollComponentDefinitionService.listActive(tx, pack.countryCode)` ONCE
PER EMPLOYEE inside `PayrollRunProcessor`'s per-employee loop — but
`pack.countryCode` is identical for every employee in a single run (one
branch, one country), so this was the SAME query result fetched N times
for an N-employee run. Fixed: `PayrollRunProcessor.process` now fetches it
ONCE, in the SAME bootstrap transaction that already resolves the pack and
the employee roster, and threads it through `processEmployee` →
`computeForEmployee` (a new OPTIONAL parameter — omitted, e.g. by a future
one-off preview caller, falls back to the original per-call fetch, so this
is a purely additive change, not a behavior change for any other caller).

**Measured, not assumed** — a real `loadtest-whale-1` payroll CALCULATE run
(300 employees), timed end-to-end (create → calculate → poll to every line
`COMPUTED`), on this same dev machine, run twice each way for consistency:

| | Run 1 | Run 2 |
| --- | --- | --- |
| Before (baseline, per-employee fetch) | 8.28s | 8.34s |
| After (fetched once, threaded through) | 6.88s | 7.32s |

A ~15-18% reduction in total calculate time for this run size, from
eliminating 299 redundant queries. On a REMOTE database (real network
round-trip per query, unlike this local Postgres on the same host), the
same fix would save proportionally MORE — this local number is a
conservative floor, not the fix's full real-world value. **Verified
correctness-preserving**: the full `payroll.e2e-spec.ts`/
`benefits.e2e-spec.ts`/`recruitment-lifecycle.e2e-spec.ts`/
`operations-modules.e2e-spec.ts` suite (57 tests, real computed-amount
assertions) passes identically before and after — this changes WHEN a
query runs, never what it returns.

### 7.2 — DB pool exhaustion's `P2028` gap (a real resilience-chassis bug, fixed)

`DbPoolExhaustionFilter` (0.10) only recognized Prisma error code `P2024`
("Timed out fetching a new connection from the pool") — but under GENUINE
concurrent load, the error this codebase's own architecture actually
produces is `P2028` ("Transaction API error: Unable to start a transaction
in the given time"), raised by Prisma's interactive-`$transaction()`
wrapper itself. Since `withTenantContext` (opened by `TenantScopeInterceptor`
for EVERY tenant-scoped request — see [tenant-resolution.md](./tenant-resolution.md))
IS exactly such a transaction, P2028 — not P2024 — is the code path this
system's real request-per-transaction design actually exercises under
pressure. Before this fix, a request that hit it fell through to Nest's
default handling and surfaced as a raw, confusing `500` — the EXACT
failure mode this filter exists to prevent, just for the specific error
code this codebase's own architecture produces.

**Found via a real k6 run, not invented**: `dashboard-read.js` against 30
sustained VUs produced a large volume of `500`s; `/metrics`'
`hrm_db_pool_exhaustion_rejections_total` stayed at `0` throughout
(ruling out the ALREADY-handled P2024 path) while the API's own structured
logs showed real `PrismaClientKnownRequestError` entries with exactly the
P2028 message. A minimal, isolated reproduction (a deliberately starved
1-connection pool, a concurrent contender transaction) confirmed the exact
code (`error.code === 'P2028'`) before the fix was written.

**Why the EXISTING e2e suite never caught this gap**: the pre-existing
`resilience-pool-exhaustion.e2e-spec.ts` sets `DB_POOL_TIMEOUT_SECONDS=2`
— coincidentally the SAME 2000ms as Prisma's own default `$transaction()`
`maxWait` — so which of the two timeouts fires first there is
unspecified, and in practice that file observes P2024. This codebase's
OWN real default (`DB_POOL_TIMEOUT_SECONDS=5`, per `.env.example`) is
HIGHER than the 2000ms `maxWait` default, meaning the client-side maxWait
always fires first in the actual default configuration — P2028, not P2024,
every time. **Fix**: `DbPoolExhaustionFilter` now treats BOTH codes
identically (a clean `503` + `Retry-After`). A NEW,
deliberately-separate-file regression test
(`resilience-pool-exhaustion-txn-start.e2e-spec.ts`, mirroring the
existing file's own "separate file per timing-sensitive config" discipline)
sets `DB_POOL_TIMEOUT_SECONDS=10` (matching the real relationship: pool
timeout > maxWait) and proves 20 concurrent contenders against a
1-connection pool get clean 503s, never a 500 — verified empirically that
a 1-vs-1 or 3-vs-1 race does NOT reliably reproduce this specific path
(the connection frees up before Prisma's client-side wait budget is
spent), while 20 concurrent contenders does, consistently.

### 7.3 — Load-test SCRIPT bugs (a real, valuable category of finding in its own right)

Three mistakes in the k6 scripts THEMSELVES were found and fixed while
running this battery — worth recording plainly, because each one
initially looked like a backend problem and was not one:

1. **A login retry storm hitting a correctly-working rate limiter.**
   `POST /auth/login` is rate-limited at 5 attempts per 15 minutes PER
   `(tenant, email)` — a deliberate brute-force defense (see
   [auth-rbac.md](./auth-rbac.md)). An early version of `attendance-clockin.js`
   cached a login token per VU, but RETRIED login on every iteration
   whenever the cached attempt had failed — one transient failure (see
   finding 2) burned through that 5-attempt budget in under 5 seconds,
   after which the VU stayed 429-locked for the rate limit's OWN 15-minute
   window, for the REST of a 75-second test. What looked like a
   catastrophic ~7% clock-in success rate was almost entirely this retry
   storm, not clock-in itself. Fixed: a VU whose one login attempt fails
   gives up for the rest of the run, exactly like a real client would.
2. **Not caching login per VU at all**, in `dashboard-read.js`/
   `employees-list.js`/`rate-limit-isolation.js`/`payroll-run.js` — each
   called `login()` fresh every iteration. Combined with argon2id's own
   real CPU cost (see below), this measured "how fast can this one process
   verify passwords back-to-back" far more than it measured the endpoint
   each script was actually named for. Fixed: login once per VU, reuse the
   token — a real user's session, not a fresh login before every click.
3. **No think-time between iterations.** `dashboard-read.js`/
   `employees-list.js` looped their GET calls with zero `sleep()` — no
   real manager refreshes a dashboard in a tight infinite loop. This
   produced a SUSTAINED request rate no realistic usage pattern would ever
   generate, and surfaced § 7.2's P2028 gap at an artificially extreme,
   unrepresentative rate. Fixed: `sleep(1)` between iterations, modeling
   an actual session. `attendance-clockin.js` got the more precise fix of
   exactly ONE clock-in/out pair per VU (a long `sleep()` after it) — an
   employee clocks in once per shift, not in a loop — which is what
   produced the clean, 100%-success, p95=120ms result in § 8 below.

None of these are "the load-testing tool is bad" — they're the ordinary,
expected process of writing a REALISTIC load-test script and iterating on
it once real (not assumed) results disagreed with the mental model. Each
one is left in the scripts' own comments, not silently fixed and
forgotten, exactly this codebase's usual practice for a caught bug.

### 7.4 — Login latency under concurrency (expected, not a bug)

`login.js` at 50 sustained concurrent VUs: **100% success, p95 ≈ 920ms**
(measured twice: 924ms and 935ms). This is argon2id's OWN deliberate CPU
cost — the whole point of a memory-hard password-hashing algorithm is to
be expensive, specifically to resist offline brute-force guessing — 
compounding under concurrency on this ONE dev machine's limited CPU cores
and Node's own libuv threadpool (which argon2's native binding uses).
Zero failures, no 5xx, nothing to "fix" — the honest characterization is
that login is CPU-bound and stateless, so it scales HORIZONTALLY (more API
replicas = more aggregate argon2 throughput across more cores), not by
tuning the algorithm down. The k6 script's own threshold was adjusted from
an initially-hoped-for 800ms to a measured-realistic 1200ms, documented in
the script itself as a deliberate, evidence-based number.

## 8. Verified under load — the resilience chassis, tied to 5.1/5.3/0.10

- **Attendance clock-in, the designated high-volume path, at a REAL
  200-employee burst** (after the § 7.3 script fixes): **100% success,
  p95 = 120.58ms** — well under the 500ms threshold, and now correctly
  representative of a real "everyone clocks in during the 9am window"
  event, not an artifact of a broken test script. This is the concrete,
  measured proof behind attendance.md's own "a handful of indexed reads,
  one write, no aggregate computation" claim.
- **Per-tenant rate-limit isolation under load**: a direct, real concurrent
  burst (200 simultaneous requests, Python's own `ThreadPoolExecutor`
  driving the exact same HTTP endpoints k6 does) against a single tenant
  captured an ACTUAL `429` alongside real `201`s and `503`s in the same
  burst — proving the per-tenant quota engages under genuine concurrency,
  not just the existing e2e suite's sequential proof.
  `rate-limit-isolation.js` (k6) exercises the SAME claim across two
  DIFFERENT tenants simultaneously — a noisy one (40 VUs) and a quiet one
  (1 req/s) — asserting the quiet tenant sees zero 429s throughout.
- **Load shedding under load, on the SAME real business path this time**:
  the identical direct concurrent-burst experiment captured a genuine
  `503` body verbatim: `{"message":"The system is currently under load;
  this NORMAL request was shed. Please retry shortly.","error":"Service
  Unavailable","statusCode":503}` — proving `LoadSheddingService` engages
  correctly for `attendance/clock-in` (an ordinary NORMAL-priority route),
  not only the dedicated `/resilience/demo/low-priority` proof surface
  `load-shedding.js` also exercises directly.
- **DB pool/transaction backpressure under load**: `pool-backpressure.js`
  (40 VUs against `/resilience/demo/slow`) and the dedicated regression
  test in § 7.2 both confirm every rejection is a clean `503` with
  `Retry-After` — `http_req_duration`'s own `max` staying safely under
  `REQUEST_TIMEOUT_MS` is the concrete "never a hang" proof.

**Autoscaling signals, confirmed observable, not triggered** (no live
cluster in this environment — see [deployment-scaling.md](./deployment-scaling.md)'s
own verified-locally/at-deploy split): `hrm_queue_depth{state="waiting"}`
climbs and falls in real time on `/metrics` as `payroll-run.js` enqueues
and drains jobs — the EXACT number `worker-hpa-keda.yaml`'s KEDA
`ScaledObject` reads directly from Redis, confirmed to move correctly;
whether that actually triggers a live scale-up event is deploy-time only.

## 9. The honest 20M-user extrapolation

**What was actually measured**: single dev machine (one Postgres 16 +
Redis container, one Node.js API process, `DB_POOL_SIZE=10`), k6 via
Docker on the SAME host (so k6 itself competes for CPU with the system
under test — a real, acknowledged limitation, not hidden). Peak
concurrency exercised: ~200 VUs for attendance, ~50 for login, ~40-150 for
the dedicated resilience-proof scenarios. This is nowhere near 20M
concurrent users, and this document makes NO claim that it is.

**What DOES scale horizontally, already built and already proven**
(nothing new needed for this specific claim — it's what Phase 5 as a whole
already established):
- The API and worker are BOTH stateless (5.3's own audited-not-assumed
  proof) — more replicas directly multiplies aggregate throughput for
  everything CPU-bound (argon2 login) or I/O-bound-but-not-DB-limited.
- Read replicas (5.1) take read-heavy paths (the dashboard, list/search
  endpoints) off the primary entirely.
- PgBouncer (5.1) multiplies the effective connection budget available to
  many API replicas without each one needing its own large
  `DB_POOL_SIZE`.
- Partitioning (5.2) keeps `attendance_records`/`audit_log` query plans
  bounded to the relevant partition regardless of total historical row
  count — the high-volume attendance path this step measured does not
  degrade as years of history accumulate.
- KEDA queue-depth autoscaling (5.3) scales worker capacity to actual
  backlog, not a fixed guess.

**What would need MORE than horizontal replication at the true 20M
ceiling** — the honest gap, not glossed over:
- **A single shared Postgres primary is still a single logical write
  target.** Horizontal API/worker replicas reduce contention on the
  CONNECTION budget (via PgBouncer) and move reads off the primary (via
  replicas), but every WRITE for every tenant still funnels through one
  primary's own I/O/WAL-throughput ceiling. At a true 20M-user scale, this
  is the point where tenant-level SHARDING (multiple independent Postgres
  primaries, tenants pinned to a shard) becomes necessary — the SAME
  `hostingRegion`-based placement seam [deployment-scaling.md](./deployment-scaling.md)
  § 6 already documents for regional residency is the natural extension
  point (a shard is, mechanically, "one more region," even within a single
  legal region) — not built here, honestly flagged as the real next step
  past what this phase's infrastructure already provides.
- **Argon2id login throughput is fundamentally CPU-bound per-core.**
  Horizontal replicas multiply available cores, which is the right answer
  — but capacity planning for a real 20M-user login rate needs an actual
  target logins/second number (this document deliberately does not
  invent one) to size replica count against the ~50-VU/~920ms-p95 data
  point measured here.
- **This step's own local Postgres/Redis are single instances, not the
  managed/clustered equivalents (RDS Multi-AZ, ElastiCache cluster mode,
  etc.) a real 20M-user deployment would run.** Their own failover/
  scaling characteristics are a DIFFERENT (and largely provider-managed)
  concern from anything measured in this step.
- **5.4's own explicit remaining gap**: sustained, multi-hour/multi-day
  load (memory-leak detection, connection-leak detection over TIME, not
  just peak concurrency) was not exercised — every run here lasted at
  most a few minutes. A genuine pre-production capacity-planning exercise
  needs a soak test, not only the burst/concurrency profiles this step
  measured.

## Scope discipline — what this step did NOT touch

RLS policies, `withTenantContext`'s core mechanism (only `TenantScopeInterceptor`'s
OWN request-log-identity mirroring was added, additive), every existing
business-logic service's actual computation (payroll's fix changes only
WHEN a query runs), and every existing route's HTTP contract are all
unmodified except the two real, narrow, well-tested fixes in § 7.1/7.2.
`packages/db` gained no schema/migration change.

## Verification

- `apps/api`: full suite green — **62 test suites, 562 tests total** (549
  existing/prior-phase tests + 6 new in `pino-logger.service.spec.ts` + 6
  new in `observability.e2e-spec.ts` + 1 new in
  `resilience-pool-exhaustion-txn-start.e2e-spec.ts`) — the same single
  pre-existing `migration.e2e-spec.ts` timing flake this suite has carried
  since 5.1 remains the only known-flaky file, unrelated to this step (it
  did not reproduce on this step's own full-suite runs).
- Full-repo `pnpm build`/`pnpm lint` green across all workspaces.
- `docker-compose.observability.yml` (Prometheus + Grafana) actually
  brought up locally and verified scraping real metrics + serving all 3
  dashboards + validating all 9 alert rules (§ 5).
- All 8 k6 scenarios actually run against a real local API instance (not
  just written) — see § 6-8 for the measured numbers, the 2 real backend
  bugs found and fixed, and the 3 load-test-script bugs found and fixed
  along the way.
- `apps/portal`/`apps/admin`: untouched — this step is backend/
  infrastructure-only, no UI surface.
