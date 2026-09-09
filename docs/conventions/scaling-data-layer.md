# Data-layer scale hardening (connection pooling, read replicas, caching)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 5.1 (Phase 5's first slice) — `docker-compose.yml`,
`docker/postgres-replica/`, `docker/postgres-primary-init/`, `packages/db`,
`apps/api/src/tenancy`, `apps/api/src/country-packs`, `apps/api/src/auth`,
`apps/api/src/migration`. Builds directly on
[tenancy-rls.md](./tenancy-rls.md) (the `current_tenant` mechanism this
whole step depends on being transaction-scoped),
[tenant-resolution.md](./tenant-resolution.md) (the flagged per-request
connection-pool tradeoff),
[resilience.md](./resilience.md) (0.10's connection-pool protection,
extended, never replaced), and the branding cache (4.3, see
[white-label.md](./white-label.md)), whose shape every cache in this step
reuses verbatim. **Goal, stated plainly: the database is never the
bottleneck at scale, while RLS/tenant-isolation and correctness are fully
preserved — every optimization below is provably isolation-preserving, not
just assumed to be.**

## 1. Connection pooling (PgBouncer)

### The #1 risk of this step, and why it's actually safe

RLS depends on `app.current_tenant` being set via
`SELECT set_config('app.current_tenant', $1, true)` — the parameterized
equivalent of `SET LOCAL` — **inside** the same Postgres transaction every
query in that request runs in (`withTenantContext`, see
[tenancy-rls.md](./tenancy-rls.md)). Postgres resets a `SET LOCAL`/
`set_config(..., true)` value automatically at COMMIT/ROLLBACK. PgBouncer,
in **transaction pooling mode**, returns a backend connection to its pool
for a DIFFERENT client to reuse at exactly that same moment — the instant
the transaction ends. There is therefore no window in which a connection
could be handed to tenant B's request while still carrying tenant A's
`current_tenant` setting: the setting and the connection's "return to pool"
event are reset by the same COMMIT/ROLLBACK, atomically, by Postgres itself
— PgBouncer has no visibility into (and no ability to interfere with)
session-local Postgres state at all. **This makes PgBouncer transaction
mode compatible with this system's RLS mechanism by construction, not by
configuration care** — the one thing that would break it (a `SET`, not
`SET LOCAL`, outside a transaction) is something this codebase's RLS
mechanism has never done, since 0.2.

This is proven directly, not just argued:
`packages/db/test/pgbouncer-rls.spec.ts` fires many (60) concurrent,
tenant-A/tenant-B-**interleaved** transactions through a Prisma client
pointed at a REAL local PgBouncer instance with a DELIBERATELY tiny
connection pool (`connection_limit=3`) — far smaller than the concurrency,
so connection reuse across different tenants' transactions is not just
possible but GUARANTEED — and asserts every single result only ever
contains its OWN tenant's rows. `apps/api/test/resilience-pgbouncer.e2e-spec.ts`
repeats the same proof at the full HTTP level (many concurrent,
interleaved-tenant requests against a real running `AppModule` routed
through the pooler) and additionally proves 0.10's connection-pool-
exhaustion backpressure (a clean `503` with `Retry-After`, never a hang)
still works identically through the pooler.

### Topology

- **Local (docker-compose)**: a new `pgbouncer` service (`edoburu/pgbouncer`,
  `POOL_MODE=transaction`), fronting the SAME `postgres` primary —
  **never** the replica (read/write splitting is a separate, application-
  level decision, see § 2, not something the pooler does). Exposed on host
  port `6432`.
- **Prod topology**: PgBouncer (or an equivalent, e.g. RDS Proxy) sits
  between every API instance and Postgres. `APP_DATABASE_URL` simply
  **points at the pooler instead of Postgres directly** —
  `postgresql://hrm_app:<password>@<pgbouncer-host>:6432/<db>?schema=public&pgbouncer=true`.
  This is the ENTIRE production cutover: `packages/db/src/clients.ts`'s
  `appPrisma` is completely unmodified by this step — it already just
  reads `APP_DATABASE_URL` from the environment, so pointing that env var
  at a pooler instead of Postgres is a config change, not a code change,
  the same "swap a connection string, not a code path" posture this
  system already takes for read-replica routing (§ 2). The one REQUIRED
  connection-string parameter is `pgbouncer=true` — Prisma's own
  documented flag for transaction-mode poolers, which disables Prisma's
  internal prepared-statement caching (a transaction-pooled connection
  cannot be assumed to be the SAME physical connection across two
  different transactions, so per-connection prepared-statement state
  cannot be trusted to persist).
- `prisma`, the OWNER/migration role (see
  [tenancy-rls.md](./tenancy-rls.md)), is **never** routed through the
  pooler — migrations need a stable, direct connection (`ALTER
ROLE`/`CREATE ROLE`/DDL, session-level `SET`s some migration tooling
  relies on) that a transaction-mode pooler doesn't reliably support. It
  keeps using `DATABASE_URL` pointed straight at Postgres, exactly as
  before this step.
- **Local dev/test default is UNCHANGED — deliberately.** `apps/api/.env`'s
  `APP_DATABASE_URL` still points directly at Postgres (`localhost:5433`),
  not at the pooler, even though the pooler is now a real, running,
  fully-proven local service (`localhost:6432`). This was an empirical
  decision, not a default left alone out of caution: **the FULL existing
  514-test backend suite was run once with `APP_DATABASE_URL` pointed at
  the local pooler, and it passed 513/514 (the one failure being the
  SAME pre-existing `migration.e2e-spec.ts` flake this suite already has
  independent of PgBouncer — see its own file header) — genuinely no
  regression.** But a closer, isolated look at `migration.e2e-spec.ts`
  specifically (many small, sequential per-row transactions in a tight
  polling loop) showed measurably HIGHER latency through the pooler in
  this environment — each pooled transaction pays a small per-transaction
  server-parameter-reset cost PgBouncer's transaction mode adds — which
  can push an already timing-sensitive test's own `waitFor` deadline
  closer to (or past) its limit. This is a real, honest, DOCUMENTED
  characteristic of transaction-mode pooling, not a correctness bug, and
  not disqualifying for production use (where the DB_POOL_SIZE-class
  connection-exhaustion risk pooling exists to solve is the far bigger
  concern) — but it's exactly why this step ships PgBouncer as a
  configurable, PROVEN, opt-in topology (flip one env var, backed by two
  dedicated real-infra test files) rather than silently re-pointing every
  existing test's default connection path without being able to
  individually re-tune each workload's own pool/timeout assumptions
  first.

### Tuning

`DEFAULT_POOL_SIZE=25`/`MAX_CLIENT_CONN=500` on the PgBouncer side (docker-
compose) comfortably exceed `appPrisma`'s own `DB_POOL_SIZE` (default 10,
see [resilience.md](./resilience.md)) — the pooler should essentially never
be the bottleneck; `appPrisma`'s own bounded pool (still fully in effect,
completely unmodified — see § "Backpressure holds" below) is. A real
deployment sizes PgBouncer's own pool from `(number of API instances) ×
DB_POOL_SIZE`, with Postgres's own `max_connections` sized to comfortably
exceed PgBouncer's pool (PgBouncer's whole point is that Postgres itself
only ever sees a small, stable number of backend connections regardless of
how many API instances/requests are in flight).

### Backpressure still holds through the pooler

0.10's `DbPoolExhaustionFilter`/bounded-pool-plus-`pool_timeout` mechanism
(see [resilience.md](./resilience.md)) is COMPLETELY UNMODIFIED by this
step — it operates on `appPrisma`'s OWN pool (`DB_POOL_SIZE`), which exists
regardless of what's on the other end of the connection string (Postgres
directly, or a pooler in front of it). Proven directly:
`resilience-pgbouncer.e2e-spec.ts`'s exhaustion test uses the exact same
tiny-pool-plus-concurrent-contender shape
`resilience-pool-exhaustion.e2e-spec.ts` already established, just with
`APP_DATABASE_URL` pointed at the pooler — same clean `503` +
`Retry-After`, same holder-still-succeeds outcome.

## 2. Read replicas (read/write splitting)

### Topology — a REAL streaming replica locally, not a simulation

`docker-compose.yml`'s `postgres-replica` service is a genuine Postgres 16
hot-standby, not a second primary or a mocked read-only flag:
`docker/postgres-replica/replica-entrypoint.sh` clones the primary via
`pg_basebackup -R` on first start (the `-R` flag writes `standby.signal` +
`primary_conninfo` for us — no manual recovery-config wrangling needed on
Postgres 12+) using a dedicated, replication-only `replicator` role
(`docker/postgres-primary-init/10-replication-role.sql`,
`20-pg-hba-replication.sh` — provisioned automatically on a FRESH primary
volume; this repo's already-existing local volume was migrated to the same
state by hand once, documented in this step's own verification notes). The
primary's `command:` gains `wal_level=replica`/`max_wal_senders=10`/
`max_replication_slots=10` (NOT reloadable — a restart, not just a config
change, which is why they're launch flags). Exposed on host port `5434`.

**Prod topology**: one or more real Postgres read replicas (managed —
RDS/Cloud SQL read replicas — or self-managed streaming replication, the
exact mechanism this step's local setup mirrors). `APP_REPLICA_DATABASE_URL`
points at a replica (or a read-only load balancer in front of several);
completely additive and optional — see below.

### RLS holds on the replica exactly as on the primary

`current_tenant` is a per-transaction Postgres **setting**
(`set_config(..., true)`), never itself replicated data — it is orthogonal
to WAL streaming by construction, the exact same reasoning that makes
PgBouncer safe in § 1. This is WHY `withReplicaTenantContext`
(`packages/db/src/tenant-context.ts`) needed **zero new RLS logic**: it is
a two-line wrapper that calls the SAME `withTenantContext` against a
different underlying client (`appReadReplicaPrisma` instead of
`appPrisma`) — one mechanism, reused, not a second one to keep in sync.
Proven directly, against the REAL replica above, by
`packages/db/test/read-replica.spec.ts`: tenant A cannot see tenant B via a
replica read, a replica query with no tenant context set still fails
loudly (no `missing_ok`, same as the primary), and — the real hot-standby
proof, independent of and in addition to this codebase simply never
issuing a write there — the replica connection genuinely REJECTS a write
attempt at the Postgres ENGINE level (`ERROR: cannot execute ... in a
read-only transaction`).

### `appReadReplicaPrisma` — additive, never required

`packages/db/src/clients.ts` exports `appReadReplicaPrisma`:
`APP_REPLICA_DATABASE_URL` unset (every environment before this step, and
any deployment choosing not to run a replica) → it's simply `appPrisma`
itself, so every read/write-splitting call site (§ below) degrades to
"read from the primary" with ZERO behavior change — never a crash, never a
silently-broken read path. Same bounded-pool-plus-`pool_timeout` shape as
every other client in this system (`packages/db/src/replica-config.ts`,
`DB_REPLICA_POOL_SIZE`) — 0.10's connection-pool protection applies here
too.

### The read/write routing decision is EXPLICIT, made by the caller — never automatic

`ReplicaReadService` (`apps/api/src/tenancy/replica-read.service.ts`) is
the one place a request handler opts a read into the replica:
`this.replicaRead.read(tx => ...)` instead of
`this.tenantContext.getTx()`. There is no automatic/heuristic routing
anywhere in this system, and there never should be — the caller is the
only one who knows whether ITS OWN read can tolerate being a little stale.

**THE RULE** (this is the one thing every future consumer of this seam
must get right):

- **Safely-stale reads go to the replica** — dashboards, reports, list
  views, precomputed analytics rollups. The worked example:
  `AnalyticsController.getDashboard` (1.5) now routes through
  `ReplicaReadService` — its dashboard reads ONLY precomputed ROLLUP
  tables, written exclusively by a scheduled BullMQ job that never runs on
  the same call stack as this request, so there is no read-your-own-write
  requirement here at all. Existing `analytics.e2e-spec.ts` (untouched)
  still passes unmodified — with no replica configured locally by
  default, this is a transparent no-op today; the ROUTING DECISION is
  what's proven, independent of whether a real replica happens to be
  wired up in a given environment.
- **Read-your-own-write paths stay on the primary** — a just-created
  record read back in the same or a subsequent request that needs to see
  it immediately (e.g. an offer just accepted, a payroll run just
  finalized, an audit entry just written). These simply keep using
  `TenantContextService.getTx()`, completely UNCHANGED by this step —
  that was already "the primary" before replicas existed, and stays that
  way; this step adds a second, explicitly-opt-in path, never touches the
  default one.

### Replication lag is handled safely, proven with an actual controlled-lag experiment

`read-replica.spec.ts`'s final test does not just assert the rule in
prose — it FORCES real lag and proves the system's actual behavior around
it: `pg_wal_replay_pause()` (a genuine Postgres admin function, called
directly against the replica) pauses WAL replay on the standby, a row is
then written on the primary, and the test asserts (a) reading it back via
the PRIMARY (`withTenantContext`) succeeds immediately — the read-your-
own-write path is unaffected by replica lag, because it never touches the
replica — and (b) reading it via the DELIBERATELY PAUSED replica
(`withReplicaTenantContext`) returns nothing, proving this is a real,
physically separate, ACTUALLY-lagging connection, not a relabeled primary.
`pg_wal_replay_resume()` is then called and the test confirms the replica
catches up on its own with no application-level intervention. This is the
concrete, empirical version of "operations needing read-after-write
consistency read from primary; only safely-stale reads go to replicas" —
not an assumption, a demonstrated guarantee.

## 3. Caching (Redis, tenant-scoped, correctly invalidated)

Every cache in this step follows the EXACT shape 4.3's
`BrandingResolutionService` already established (see
[white-label.md](./white-label.md) § 1): a short Redis TTL as a SAFETY NET,
never the primary consistency mechanism; an EXPLICIT invalidation call on
every real write that changes the underlying data, which is what actually
keeps the cache correct; a tenant-scoped (or, where finer-grained,
tenant+entity-scoped) cache key, NEVER a global one that could serve one
tenant's data to another. `REDIS_CLIENT` (the same token
`RateLimiterService`/`IdempotencyService`/`BrandingResolutionService`
already share) is reused throughout — no new Redis connection, no new
caching subsystem.

### What's actually cached, and why each one is safe

- **Country packs** (`CountryPackResolutionService`, extended, not
  rebuilt) — `resolveEffectiveConfig`'s result, key
  `country-pack:effective:<tenantId>:<countryCode>`, 60s TTL.
  Invalidation: `CountryPacksController.putOverride` busts the ONE
  `(tenant, countryCode)` pair it just wrote; `PlatformCountryPackService`'s
  global mutations (a new pack's first version, or activating a different
  version — see [country-packs.md](./country-packs.md)) bust EVERY
  tenant's cached entry for that country code via a non-blocking Redis
  `SCAN` (never `KEYS`) — acceptable cost for a rare platform-admin
  action, not a per-request hot path. Proven in
  `apps/api/test/scaling-data-layer.e2e-spec.ts`: an override takes effect
  on the VERY NEXT read (not a 60s wait), and tenant A's override is never
  visible to tenant B's independent resolution of the same country code.
- **Org/branch structure** (`OrgStructureCacheService`, new) — a tenant's
  branch list, key `org-structure:branches:<tenantId>`, 60s TTL. This
  codebase has no dedicated branch-management CRUD module (branches are
  created by seeding or by the 3.5.1 migration importer only — see
  [data-migration.md](./data-migration.md)) — that importer's `runCommit`
  is the one real write path this cache hooks (`invalidate(tenantId)`
  right after a committed BRANCH batch, never during the dry run, which
  never reaches that point). Proven in the same e2e file: a branch
  imported through the real migration toolkit appears on the VERY NEXT
  `GET /tenancy/branches` read, and tenant B's list is completely
  unaffected by tenant A's import. **Honest scope note**: a FUTURE
  dedicated branch-management endpoint must call
  `OrgStructureCacheService.invalidate(tenantId)` after any create/
  update/delete, the same obligation every cached-write pair in this step
  carries.
- **Permissions** (`PermissionsCacheService`, new, wraps
  `loadUserContext`) — THE hottest read in the whole system: every single
  authenticated request resolves it inside `TenantScopeInterceptor.authenticate`
  (see [auth-rbac.md](./auth-rbac.md)). Key
  `permissions:<tenantId>:<userId>`, a SHORT 15s TTL. **Does NOT cache
  whether the user is still ACTIVE** — `TenantScopeInterceptor` re-checks
  `User.status` fresh from the DB on every request BEFORE ever consulting
  this cache, so a deactivated user is blocked immediately regardless of
  anything cached here; only the roles/permissions/branch-scope SHAPE is
  cached. Proven tenant+user-scoped in `scaling-data-layer.e2e-spec.ts`: a
  TENANT_ADMIN and a plain EMPLOYEE in the SAME tenant get correctly
  DIFFERENT (allow/deny) outcomes on the same permission-gated route, with
  no bleed between them. **Honest gap, stated plainly, not glossed over**:
  this codebase has NO role-management or user-role-assignment mutation
  endpoint at all yet (only enforcement + seeding — see
  [auth-rbac.md](./auth-rbac.md)'s own note), so there is no real write
  path to hook an immediate invalidation into for "an admin edited a
  role's permission set" — for that one specific scenario, the 15s TTL is
  the PRIMARY bound on staleness today, not merely a backstop the way it
  is for every other cache in this step. The two real `UserRole`-creating
  write paths that DO exist (`SsoService`'s JIT provisioning, a brand-new
  user) call `invalidate()` defensively right after, even though a
  brand-new user has no pre-existing entry to go stale — consistent
  hygiene, not a claim that this closes the gap above. The day a real
  role-editing endpoint is built, it MUST call `invalidate(tenantId,
userId)` for every affected user as part of that work.

### What was CONSIDERED and deliberately NOT cached — a real, empirically-confirmed finding

**Feature flags / entitlement resolution
(`FeatureFlagResolutionService.resolve`, used by `FeatureFlagGuard` /
`@RequireFeature`) was built, wired in, and then REVERTED during this
step** — not a theoretical decision, an empirically-forced one. A cached
wrapper (keyed `entitlement:<tenantId>`, invalidated from
`BillingService.applySubscriptionFromStripe` and
`LicensingAdminService.issue`/`revoke`/`setFlagOverride`) was implemented
and initially looked correct. Running the EXISTING, untouched
`licensing-saas.e2e-spec.ts` suite against it immediately surfaced the
real problem: that suite (entirely legitimately) manipulates `Subscription`
rows DIRECTLY via the owner `prisma` client to test entitlement resolution
reacting to a status change — a pattern completely outside the two hook
points a cache could realistically invalidate from. The result was exactly
the failure mode `showPoweredBy`'s own write-up in
[white-label.md](./white-label.md) already warns against: a stale,
PRE-CHANGE entitlement resolution kept being served, letting a
`@RequireFeature`-gated route return `200` when it should have `403`'d
(and, by the same logic, could equally serve a stale BLOCKED result after
a real upgrade). Any OTHER future code path that writes `Subscription`/
`License`/`TenantFeatureFlagOverride` directly — not hypothetically, this
codebase's own test suite already does it — would silently bypass the
cache the same way. Given "stale entitlement is a security issue, not just
a freshness one" is the whole point of this step's own brief, the
responsible call was to REVERT this one cache rather than ship it
narrower-than-safe. `FeatureFlagGuard` was restored to calling
`FeatureFlagResolutionService.resolve` fully fresh, exactly as before this
step — this is a NON-change, verified by the full existing suite passing
identically to its pre-step baseline. This is recorded here, prominently,
because it's a genuine finding worth a future reader trusting over a
theoretical "why not cache everything" instinct: entitlement resolution in
THIS codebase is not safely cacheable without either (a) a much more
invasive audit/lock-down of every Subscription/License/override write
path (out of scope for this step, and arguably undesirable — those tables
are legitimately written from several independent places: Stripe webhooks,
interactive plan changes, platform admin actions, and tests), or (b) a TTL
so short it stops being a meaningful cache at all.

### Critical property, proven, not assumed

Every cache above is tested for the SAME two things: (1) a change on the
real write path is reflected on the VERY NEXT read (not a TTL-bounded
wait), and (2) one tenant's (or, for permissions, one tenant+user's) cached
value is NEVER served to another — the tenant-scoped key IS the isolation
boundary here, the same way `tenant_id = current_tenant` is the isolation
boundary at the database layer. Caching never bypasses RLS: every cache
population still reads through the caller's own RLS-scoped transaction
first; a cache only ever holds what RLS already allowed that specific
tenant to see.

## Scope discipline — what this step did NOT touch

RLS policies, `withTenantContext`'s core mechanism, `TenantScopeInterceptor`'s
resolution/auth ordering, `FeatureFlagResolutionService`'s own resolution
logic (only its CALLER — the guard — was touched, then reverted), the
0.10 resilience chassis's rate limiting/circuit breakers/load shedding/
idempotency (all completely unmodified — connection pooling is extended,
not replaced), and every existing module's business logic. `packages/db`
gained two new files (`replica-config.ts`,
`appReadReplicaPrisma`/`withReplicaTenantContext` in the existing
`clients.ts`/`tenant-context.ts`) — no schema migration was needed for
this step at all (caching and pooling are infrastructure, not data model).

## Verification

- **`packages/db`**: 28/28 tests green (22 existing across
  `tenant-isolation.spec.ts`/`audit-log-immutability.spec.ts`/
  `signature-event-immutability.spec.ts`, + 3 new in
  `pgbouncer-rls.spec.ts` + 6 new in `read-replica.spec.ts`), against REAL
  local infra (Postgres, a real streaming replica, PgBouncer).
- **`apps/api`**: full suite green (514 existing + 2 new e2e files —
  `resilience-pgbouncer.e2e-spec.ts` (2 tests) and
  `scaling-data-layer.e2e-spec.ts` (5 tests) — 521 total), with the SAME
  single pre-existing `migration.e2e-spec.ts` timing flake this suite
  already carries independent of this step (confirmed by an isolated,
  uncontended rerun passing 10/10 cleanly), zero regressions. In one
  full-suite run, `migration.e2e-spec.ts` itself passed clean but
  `scaling-data-layer.e2e-spec.ts`'s own branch-import cache-invalidation
  test flaked instead — expected, not a new class of problem: that test
  exercises the IDENTICAL async migration-processing/BullMQ pipeline
  `migration.e2e-spec.ts`'s own known flake already comes from (see that
  file's header), so it inherits the same full-suite-parallel-load timing
  sensitivity. Confirmed unrelated to the caching/invalidation logic
  itself by an isolated rerun: 5/5 green in 7.5s.
- Full-repo `pnpm build`/`pnpm lint` green across all workspace tasks.
- `apps/portal`/`apps/admin` Playwright suites: untouched — this step is
  backend/infra-only (no UI surface), verified by their existing suites
  needing no changes.
