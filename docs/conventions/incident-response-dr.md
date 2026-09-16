# Incident response, disaster recovery & chaos testing

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Phase 6.4, the FINAL step of the whole build. Deliberately not a new
subsystem: this step's job is to (1) write down how a human responds when
something in Phase 0–6's chassis breaks, (2) state the disaster-recovery
plan built entirely on 6.2's already-tested backup/restore and 5.2's
archival/5.3's regional seams (never a re-implementation), and (3) prove —
with real, automated tests against the real local stack, not a checklist —
that the resilience chassis (0.10), the observability stack (5.4), and the
edge posture (6.3) actually deliver graceful degradation under real,
induced failure. Two genuine weaknesses were found by these tests and
FIXED in this step, in the same spirit 5.4 found and fixed a payroll N+1
and a `DbPoolExhaustionFilter` gap — see § Chaos experiments below for
both.

## 1. Incident response runbook

### 1.1 Severity classification

| Severity | Definition                                                                                                                   | Example                                                                                                                                                                   | Response                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **SEV1** | Full outage or active data breach — the platform is down for all/most tenants, or tenant data is confirmed exposed/tampered. | API unreachable across every instance; a confirmed cross-tenant RLS bypass; `audit_log` shows unauthorized platform impersonation.                                        | Immediate page, Incident Commander assigned within 5 min, status page updated. |
| **SEV2** | Significant degradation, not a full outage — a whole module or a subset of tenants materially affected.                      | Payroll run queue backlog > 5000 (`HrmQueueBacklogCritical`); DB pool exhaustion firing > 1/min (`HrmDbPoolExhaustionFrequent`); one tenant's data resolvable by another. | Page within 15 min, IC assigned, mitigation attempted before full RCA.         |
| **SEV3** | Limited/contained impact — one tenant, one route, or a non-critical feature.                                                 | A single tenant hitting its own rate limit legitimately; one circuit breaker open on a non-critical notification channel.                                                 | Business-hours response, tracked, no page.                                     |
| **SEV4** | Cosmetic/low-risk — no user-facing impact or a near-miss caught by monitoring/tests.                                         | A load-shedding blip that recovered on its own; a chaos-test-style near-miss found in staging.                                                                            | Logged, addressed in normal sprint work.                                       |

### 1.2 Roles

- **Incident Commander (IC)** — owns the incident end to end: declares
  severity, coordinates responders, decides when to escalate/de-escalate,
  approves customer-facing comms. Does NOT necessarily do the hands-on
  fix.
- **Ops/Engineering lead** — drives technical mitigation (the person
  actually running `platform-tenant.service.ts`'s `suspend`, a rollback,
  a scale-out, etc.).
- **Comms lead** (SEV1/SEV2 only) — owns the status page and any
  tenant-facing notification, including the breach-notification duties in
  § 1.4 below.
- **Scribe** — keeps a timestamped log of what was observed/done (this
  becomes the postmortem's factual timeline, and — for a security
  incident — is itself evidence, alongside the real `audit_log`/
  `platform_audit_log` trail 0.9/4.1 already produce).

For a one-person/small-team reality (this codebase's actual current
operating model), one person may hold multiple roles simultaneously, but
the ROLES still separate cleanly: technical response is not the same
decision as "do we owe tenants a notification," and conflating them is
exactly how a breach notification gets forgotten under pressure.

### 1.3 Detection → triage → mitigation → resolution → postmortem

**Detection** is tied to REAL, already-shipped signals — nothing invented
for this step. From `deploy/observability/prometheus/alerts.yml` (5.4):

| Signal                                                                    | What it means                                                                                                       | Likely incident type                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HrmHighErrorRate` (>5% 5xx, 5m)                                          | Something broad is actually failing, not just slow.                                                                 | App bug, bad deploy, dependency outage.                                                                                                                                           |
| `HrmHighLatencyP99` (>2s, 10m)                                            | Degraded, not yet down.                                                                                             | DB/replica pressure, a slow external adapter.                                                                                                                                     |
| `HrmQueueBacklogGrowing` / `HrmQueueBacklogCritical`                      | BullMQ jobs (payroll runs, notifications, imports, partition/report jobs) piling up faster than workers drain them. | Worker capacity, a stuck/crash-looping job, `PROCESS_ROLE` misconfiguration (5.3).                                                                                                |
| `HrmDbPoolExhaustionFrequent` (503s from `DbPoolExhaustionFilter`)        | The bounded connection pool (0.10) is genuinely saturated.                                                          | Read/write load spike, a runaway query, need for read-replica routing (5.1) or more `DB_POOL_SIZE`/instances.                                                                     |
| `HrmCircuitBreakerOpen` (2m+)                                             | A wrapped dependency (a notification provider today) is failing consistently.                                       | External provider outage — the breaker is ALREADY containing it; the alert is "go check the provider," not "go fix the app."                                                      |
| `HrmRateLimitRejectionsSpike`                                             | One tenant/API key hammering its quota.                                                                             | Either a legitimate need to raise a per-tenant override (0.10/4.1) or abuse/a bug in a tenant's own integration.                                                                  |
| `HrmLoadSheddingActive`                                                   | The app is actively protecting itself by shedding non-critical traffic.                                             | Real capacity pressure — scale-out (the api HPA, 5.3) is the actual fix; the alert firing means 0.10 is already doing its job.                                                    |
| `HrmProcessDown`                                                          | Prometheus can't scrape an `hrm-api`/`hrm-worker` target for 1m.                                                    | A crashed/unhealthy pod, a bad rollout (5.3's readiness/liveness probes should already be preventing traffic from reaching it).                                                   |
| `hrm_redis_unavailable_fail_open_total` rising (new this step, see § 3.1) | Redis is unreachable and rate limiting is running unmetered as a result.                                            | Redis outage — the app stays up (by design, this step's own fix), but this metric is the signal an operator must not ignore: the app is temporarily UNMETERED, not merely "fine." |

Structured, correlated JSON logs (5.4, `PinoLoggerService`, every log line
carries the request's tenant/request id) are the next step after an
alert — grep/query by the SAME correlation id a slow/failing request's
trace carries (5.4's OpenTelemetry tracing). 6.3's edge posture
(`deploy/edge/waf/`, `deploy/edge/ddos/RUNBOOK.md`) is the layer BEFORE
any of this fires for a genuine volumetric flood: a real WAF/CDN absorbs
it before it reaches these alerts at all; `HrmLoadSheddingActive` firing
in the ABSENCE of any edge-reported block is itself a signal the flood is
already past the edge and hitting the app directly.

**Triage** — the IC (or the sole responder) answers, in order: (1) is
this SEV1/2 (active breach, broad outage) or lower? (2) is it getting
worse, stable, or already recovering (is the resilience chassis already
containing it — an open breaker, active load shedding, or a clean 503
stream are all the chassis WORKING, not necessarily an emergency)? (3)
what does the alert + trace/log correlation actually point at?

**Mitigation** — reach for the REAL, already-built levers first, never a
one-off manual fix:

- **Contain a bad tenant/traffic source**: a per-tenant rate-limit
  override (`PATCH /platform/rate-limits/:tenantId`, 0.10/4.1) or, for a
  genuinely compromised/abusive tenant, **suspend it**
  (`PlatformTenantService.suspend` → `POST /platform/tenants/:id/suspend`,
  4.1) — `TENANT_STATUS` enforcement means this is a REAL, immediate
  block, including that tenant's own login route, not a soft flag.
- **Contain a bad dependency**: circuit breakers (0.10) already fail
  fast automatically; `CircuitBreakerService.reset(name)` is the
  documented manual escape hatch once a dependency is confirmed healthy
  again, if the automatic `HALF_OPEN` recovery is taking longer than
  acceptable.
- **Relieve DB/queue pressure**: scale the api/worker Deployments (5.3's
  HPA/KEDA should already be doing this automatically); route more reads
  through the read replica (5.1) if the bottleneck is read-heavy; check
  `HrmQueueBacklogCritical`'s named queue against `worker-hpa-keda.yaml`'s
  own scaling target.
- **Roll back a bad deploy**: see § 2.2 below — this is a DR procedure,
  not improvisation.

**Resolution** — the triggering alert clears AND stays clear for a
reasonable observation window (not just a momentary dip), confirmed
against the same dashboards/alerts that detected it.

**Postmortem** (SEV1/SEV2, blameless) — the Scribe's timeline plus the
REAL audit/metrics trail (never reconstructed from memory) becomes a
written postmortem: what happened, detection lag (alert fired at X, human
response started at Y), what contained it, root cause, and concrete
follow-up (a new alert, a new chaos experiment added to § 3, a config
change). This step's own two chaos-found fixes (§ 3.1, § 3.2) are exactly
the SHAPE a real postmortem action item takes — this document's job is to
make that habit real, not just describe it.

### 1.4 Security-incident / breach response

**Containment**, using REAL platform tooling (4.1), never a manual DB
edit:

1. **Confirm scope** via the platform's own cross-tenant audit read —
   `PlatformAuditQueryService.readTenantLog`/`readPlatformLog` (backing
   `GET /platform/audit/...`) — a legitimate, itself-audited cross-tenant
   read (see vendor-console.md § the owner-`prisma` access pattern): what
   actions, by whom, against which tenant(s), and when.
2. **Suspend the affected tenant(s)** if the incident is tenant-scoped
   (a compromised tenant admin account, a leaked API key) —
   `POST /platform/tenants/:id/suspend` genuinely blocks that tenant,
   including its own login, per 4.1's `TENANT_STATUS` enforcement. This is
   reversible (`resume`) once the incident is understood and the specific
   compromised credential/key is rotated/revoked.
3. **If the incident involves a platform admin account** (the more
   severe case — platform admins are a structurally separate identity
   space from tenant `User`, 4.1): revoke that admin's sessions/rotate
   `PLATFORM_JWT_SECRET` (which invalidates every platform session
   process-wide — a blunt but immediate lever exactly because platform
   tokens are signed with a SEPARATE secret from tenant tokens, so this
   never affects tenant-facing auth).
4. **If impersonation is implicated**: 4.1's impersonation sessions are
   already server-side time-boxed (the session row is live-checked on
   every request, not just the JWT's own `exp`) and LOUDLY dual-audited
   (into both the platform's own trail and the target tenant's own
   `audit_log`, tagged with the real admin's id) — the investigation
   reads directly off that trail; there is no "impersonation with no
   trace" case to worry about by construction.

**Investigation** — the append-only, DB-immutable `audit_log` (0.9,
partitioned since 5.2, `REVOKE UPDATE/DELETE` proven to hold even through
partitioning and 6.2's restore drill) is the source of truth for "what
actually happened," not application logs alone (which are correlated and
useful for context, but not tamper-evident the way `audit_log` is by
construction).

**Data-breach notification checklist** — ties directly into 6.1's privacy
work, never a bespoke process:

- Determine which `DataCategory`/`DataSubject`s were actually exposed —
  read this off 6.1's own export/consent/processing-register machinery
  (`PrivacyController`'s `/register`, `/sub-processors`, and a
  data-subject's own `/requests/:id/export` shape exactly what "what data
  do we hold and process on this person" already means in this codebase)
  rather than reconstructing it ad hoc during an incident.
- **Regulator + data-subject notification timelines are jurisdiction-
  specific and MUST be confirmed with qualified legal counsel before
  relying on this list** — the same explicit compliance-boundary framing
  payroll.md/pakistan-pack.md/statutory-reporting.md already take for
  their own domains. As a starting orientation only:
  - **GDPR-style regimes** (general reference, most EU/EEA tenants): a
    72-hour regulator-notification clock from becoming aware of the
    breach is the commonly-cited benchmark; affected data subjects must
    be told "without undue delay" when the breach poses a high risk to
    their rights.
  - **Pakistan** (this codebase's concrete first-client jurisdiction —
    see pakistan-pack.md/privacy-residency.md's `me-south-1` residency
    case): Pakistan's data-protection framework was still maturing as of
    this codebase's own reference material and does not yet have the
    same universally-settled breach-notification clock GDPR does —
    **VERIFY current statutory notification obligations with Pakistani
    counsel before relying on any specific timeline**, the same explicit
    VERIFY discipline pakistan-pack.md already applies to every
    legally-sensitive payroll figure.
  - Whatever the jurisdiction, the SAME two audiences always apply:
    affected data subjects (via 6.1's existing notification/consent
    machinery + the notification hub, 0.8) and the relevant regulator —
    and the Comms lead (§ 1.2), not an individual engineer, owns sending
    either.

## 2. Disaster recovery plan

Every scenario below REUSES the mechanisms 6.2 (backup/restore), 5.2
(archival), and 5.3 (regional deployment) already built and tested — this
step deliberately implements none of the underlying recovery machinery
itself, only the PLAN for when to reach for each one, plus one new,
locally-runnable verification script (§ 2.5).

| Scenario                                                                                           | Recovery procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | RPO                                                                                                                                                                                                                                                                          | RTO (honest estimate)                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB loss** (primary Postgres instance destroyed/corrupted)                                        | Restore the most recent encrypted backup via `ops/backup/backup-postgres.sh`'s artifact + the SAME mechanism `ops/backup/restore-drill.sh` already proves end to end (decrypt → `pg_restore` → verify row counts/RLS/`audit_log` immutability) — but restoring into the REAL primary role, not a scratch DB. If a read replica (5.1) is still alive and caught up, PROMOTING it is a much faster interim path while a fresh primary/backup restore completes in parallel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Since the last successful backup run (a scheduled interval — see DR-RUNBOOK.md; NOT continuous/zero) — a genuinely lossy RPO for anything written after the last backup, honestly stated.                                                                                    | Backup-restore path: the time `restore-drill.sh` already takes locally (minutes, dominated by `pg_restore`) plus re-pointing `DATABASE_URL`/`APP_DATABASE_URL` and a rolling restart (5.3) — realistically 15–60 minutes depending on DB size. Replica-promotion path (if available and caught up): minutes, not tens of minutes. |
| **Region outage** (an entire regional deployment, e.g. `me-south-1`, becomes unreachable)          | 5.3's regional-deployment seam is EXPLICITLY a fully separate, shared-nothing stack per region with tenant→region pinning falling out of 0.3's subdomain resolution — DR here means standing up (or already having standing by) an equivalent stack in a second region and re-pointing DNS/tenant routing, then restoring that region's own tenants' data from THEIR most recent cross-region-replicated backup artifact. **Honestly out of reach to test in this sandboxed environment** (no second region, no real DNS control) — same boundary 5.3/6.3 already draw for themselves.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Same as DB loss (backup-interval-bound) UNLESS backups are also replicated cross-region in near-real-time (a deployment-time operational decision, not something this codebase enforces in code).                                                                            | Hours, dominated by provisioning a second region's stack if one isn't already warm-standby, plus DNS propagation — NOT minutes; stated honestly as the most expensive scenario here.                                                                                                                                              |
| **Ransomware** (primary + local backups both encrypted/destroyed by an attacker with write access) | Recover from the OFFSITE, ENCRYPTED backup artifacts `ops/backup/backup-postgres.sh`/`backup-minio.sh` already produce (AES-256/GPG, per 6.2) — the ransomware-resilience property that actually matters is that these artifacts are encrypted AT REST under a key the application/DB credentials themselves cannot derive, and are stored somewhere the compromised app/DB credentials alone cannot reach/delete (an offsite object store with a SEPARATE credential — an operational/deployment requirement this doc states explicitly, since this codebase's own backup scripts don't themselves enforce WHERE the artifact ends up). A genuinely hardened posture adds object-store versioning/WORM (write-once-read-many) retention on the backup bucket itself so even a compromised backup-uploading credential can't delete prior versions — **a deployment-time bucket-policy decision, not something these scripts configure today; flagged here as the concrete next hardening step**, not claimed as already done. | Same backup-interval RPO as DB loss — ransomware detection is often not immediate, so the SAFE restore point is the last backup taken BEFORE any sign of compromise, which may be earlier than the most recent one.                                                          | Similar to DB loss, plus investigation time to establish a safe restore point and rotate every credential the attacker may have touched (DB roles, `FIELD_ENCRYPTION_KEY` per 6.2's rotation seam, `JWT_SECRET`/`PLATFORM_JWT_SECRET`).                                                                                           |
| **Bad deploy** (a rollout regresses correctness/availability)                                      | See § 2.2 — a rollback, not a restore; data is not lost, so this is the FASTEST scenario here by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Zero (no data loss — this is a code-only regression).                                                                                                                                                                                                                        | Minutes — a `kubectl rollout undo` against a Deployment that was ALREADY proven zero-downtime/health-check-gated in 5.3.                                                                                                                                                                                                          |
| **Data corruption** (a bad migration/bug silently writes wrong data, discovered after the fact)    | Depends on how far back the corruption started: if within the archival retention window (5.2), the corrupted table's aged-out rows may already be recoverable from an exported archive partition (`PartitionArchivalService`'s gzip/JSON export to object storage); more commonly, a point-in-time restore from a backup taken BEFORE the corrupting change, into a scratch DB (exactly `restore-drill.sh`'s own pattern), then a targeted, audited data-repair script reconciling only the affected rows against the restored copy — never a blind full restore, which would also discard every legitimate write since.                                                                                                                                                                                                                                                                                                                                                                                                       | Depends entirely on how long the corruption went undetected before discovery — potentially the single WORST-case RPO here, which is precisely why 5.4's alerting + this step's own detection signals matter: the sooner a corrupting bug is caught, the smaller this window. | Hours — dominated by the manual reconciliation step, which is inherently bespoke per incident, not automatable in general.                                                                                                                                                                                                        |

### 2.1 Backup/restore — reused, not reimplemented

Every "restore" step above is the SAME mechanism `ops/backup/backup-
postgres.sh` (produces the encrypted artifact) and `ops/backup/restore-
drill.sh` (proves it restores correctly — row counts, RLS, `audit_log`
immutability, all verified against a REAL restored database, per 6.2) —
see [`security-hardening.md`](./security-hardening.md) for the full
write-up. This step adds no new backup/restore code; § 2.5 below adds one
new, narrower verification script alongside it.

### 2.2 Rollback procedure for a bad deploy

Reuses 5.3's zero-downtime rollout + migration-job safety directly (see
[`deployment-scaling.md`](./deployment-scaling.md) and
`deploy/k8s/base/`):

1. **Detect** via 5.4's signals (`HrmHighErrorRate`, `HrmProcessDown`,
   failing readiness probes) or a failed post-deploy smoke check.
2. **Roll back the Deployment(s)**: `kubectl rollout undo deployment/hrm-
api -n hrm` (and `hrm-worker`/`hrm-portal`/`hrm-admin` as needed) —
   safe because 5.3's readiness/liveness probes and `PodDisruptionBudget`s
   already guarantee the rollback ITSELF is zero-downtime, the same as
   the forward rollout was.
3. **Migration safety**: `deploy/k8s/base/migration-job.yaml` runs
   migrations as a single, waited-on Job BEFORE any pod rollout — a
   rollback to a PRIOR code version while a NEWER migration has already
   applied is the one genuinely unsafe case (old code against a new
   schema). This is why every migration in this codebase is written
   additive-first (see `partitioning-archival.md`'s own "additive
   conversion" framing, and the general convention every phase's own
   migrations have followed) — a rollback of CODE alone, without a
   matching schema rollback, is safe specifically because migrations
   never destructively drop/rename a column the previous code version
   still reads. A schema change that genuinely cannot be made additive is
   the one case requiring a coordinated data-migration rollback plan
   BEFORE that migration ships, not after.
4. **Verify** the same alerts/probes that detected the regression have
   cleared.

### 2.3 Ransomware resilience — what's real vs. what's a deployment decision

Real today: encrypted-at-rest backup artifacts (6.2, AES-256/GPG), a
tested restore path (`restore-drill.sh`), and `audit_log`'s own DB-level
immutability (0.9, `REVOKE UPDATE/DELETE FROM hrm_app` — even a fully
compromised APPLICATION credential cannot tamper with the audit trail
itself, only the owner/migration role can, which the running app never
uses for request-time queries per tenancy-rls.md's own two-role design).
Explicitly a DEPLOYMENT decision, not enforced by this codebase: WHERE
backup artifacts are stored (must be a genuinely separate credential/
account from the app's own, ideally with object-store versioning/WORM
retention) — stated honestly as a gap/next step, not claimed as solved.

### 2.4 Honest RPO/RTO framing

Every number in the table above is an ESTIMATE reasoned from the actual
mechanisms involved (backup interval, `restore-drill.sh`'s own observed
local runtime, 5.3's proven-zero-downtime rollout), not a measured SLA —
this codebase has no continuous/near-zero-RPO replication path for
Postgres today (5.1's read replica is for READ scaling and a faster
region-outage fallback, not a synchronous zero-data-loss standby), and
stating otherwise would be exactly the kind of unverified claim this
project's own documentation discipline (see 5.3/6.3's "verified-locally
vs. verified-at-deploy" framing) exists to prevent.

### 2.5 A DR verification that IS locally runnable

`ops/backup/verify-latest-backup.sh` (new this step) — a narrower,
faster, non-destructive companion to `restore-drill.sh`: decrypts the
most recent backup artifact and asserts it is a STRUCTURALLY VALID
`pg_restore`-compatible archive (via `pg_restore --list`, which reads and
validates the archive's own table-of-contents without touching any
database at all) and reports its size/table count — the kind of check a
scheduled job could run after every backup completes, cheaply, without
needing a scratch database the way a full restore drill does. This is
NOT a replacement for `restore-drill.sh`'s own full row-count/RLS/
immutability proof (still the authoritative test, run periodically per
DR-RUNBOOK.md) — it is the fast, frequent "is last night's backup even
well-formed" check that makes catching a SILENTLY BROKEN backup (e.g. a
truncated upload) a same-day discovery instead of a discovery only at
the worst possible moment, during a real restore. **Verified locally**:
run against a real backup artifact produced by `backup-postgres.sh` in
this same environment — see its own header comment for exact invocation.
Region failover and full multi-region DR are explicitly NOT exercised by
anything in this repository — no second region exists in this sandboxed
environment, the same honest limitation 5.3/6.3 already state about
themselves.

## 3. Chaos experiments

Five automated chaos experiments, each a real Jest e2e test run against
the actual local stack (real Postgres, real Redis, real BullMQ, a real
S3-API-compatible object store standing in for MinIO in this sandboxed
environment — see § 4), under `apps/api/test/chaos/`. Every experiment
asserts a concrete, machine-checked outcome — none of this is a manual
checklist. Two of the five found and FIXED a real weakness; the other
three confirmed the existing chassis already holds.

### 3.1 Redis killed and restarted — `chaos-redis-down.e2e-spec.ts`

**What it does**: spins up a DISPOSABLE, private `redis-server` child
process (so it can be genuinely SIGKILLed without taking down the shared
Redis instance every other suite in the run depends on), points a real
Nest app at it, proves a baseline healthy request, SIGKILLs the process,
and asserts what happens to (a) `/health/ready`, (b) a real tenant-scoped
request, and (c) recovery once Redis restarts.

**A REAL weakness found and fixed — in TWO layers, not one**. First
found: `TenantRateLimitService.enforce` — called from
`TenantScopeInterceptor` on the hot path of EVERY tenant-scoped request,
before the DB transaction even opens — had NO error handling around its
Redis calls. Fixing only that surfaced a SECOND, equally real instance of
the exact same gap one hop later: `PermissionsCacheService.getContext`
(5.1's permissions cache — "THE hottest resolve-fresh-every-request read
in the whole system," per its own doc comment, called from
`TenantScopeInterceptor.authenticate()` for every authenticated request)
had the identical missing error handling. Before either fix, killing
Redis turned every single tenant-scoped/authenticated request into an
uncaught error and a raw, uninformative `500` — a Redis blip taking down
the ENTIRE app, directly contradicting 0.10's own "no single layer
trusted alone" posture. A THIRD, compounding gap made both worse: ioredis's
own default behavior for a disconnected client is to QUEUE commands and
wait for reconnection rather than reject promptly, so even a `try/catch`
alone did nothing until ioredis's internal retry budget was exhausted —
which this step's own chaos test caught taking FAR longer than any
request should wait (the test itself timed out against it before the fix
below).

**The fix, three parts**: (1) `RedisModule`'s shared `ioredis` client now
sets `commandTimeout` (default 2000ms, `REDIS_COMMAND_TIMEOUT_MS`) — ONE
client-level setting that bounds EVERY command issued through the shared
connection, rather than requiring every future Redis caller to remember
its own timeout (the same "fix it at the one shared layer" reasoning
`pool-config.ts`'s own `DB_POOL_TIMEOUT_SECONDS` already applies to the
DB pool); (2) `TenantRateLimitService.enforce` now fails OPEN when Redis
is unreachable — the real `TooManyAttemptsException` (an actual 429) is
still re-thrown untouched, but any OTHER error is caught, logged, and the
request is allowed through UNMETERED; (3) `PermissionsCacheService.getContext`
now fails OPEN too — a Redis error degrades to "compute permissions from
Postgres, don't cache" rather than failing the request (correctness is
unaffected either way, `loadUserContext` is always the source of truth;
only the cache hit rate drops to zero for the outage's duration). Both
(2) and (3) increment the SAME new Prometheus counter,
`hrm_redis_unavailable_fail_open_total{check="tenant-rate-limit"|"permissions-cache"}`
(see `MetricsService`) — one real, alertable signal (§ 1.3's detection
table) covering every Redis-dependent hot-path fallback together, never a
silent gap. `readiness` already correctly reported Redis-down before any
of this (`ReadinessService.checkRedis` already had its own try/catch) —
only the REQUEST-serving path had the gap, in two places.

**Deliberately scoped, honestly**: `commandTimeout` bounds every Redis
call uniformly, but only `TenantRateLimitService`/`PermissionsCacheService`
(the two call sites this chaos test actually caught hanging on the
authenticated-request hot path) were given explicit fail-open handling.
`CircuitBreakerService`/`IdempotencyService` also depend on Redis but are
invoked from narrower, already-retry-aware call sites (BullMQ job
processors with their own `attempts`/backoff, or explicitly opted-in
`@Idempotent()` routes) — now individually bounded by the same
`commandTimeout` (so none of them can hang indefinitely either), but NOT
given their own fail-open logic here; extending that is a reasonable,
flagged follow-up, not silently ignored, but out of this step's scope.

**Verified locally**: real `redis-server` process genuinely killed and
restarted; readiness observed flipping 503→ready across the kill/restart;
a real tenant-scoped request observed returning 200 (not 500, and not a
15s+ hang) while Redis was down; rate limiting observed resuming
enforcement (a real 429) once Redis came back. The fix was iterated
TWICE against this same real running test — first `commandTimeout` alone
was insufficient (the request still took the full multi-second bound
just for permissions caching, then failed elsewhere), which is exactly
how the second gap (`PermissionsCacheService`) was found, not assumed.

### 3.2 DB connection-pool exhaustion — `chaos-db-pool-exhaustion.e2e-spec.ts`

**What it does**: a RE-VERIFICATION, not a new mechanism. 5.4's own load
testing found that this codebase's actual architecture — EVERY tenant-
scoped request runs inside an interactive `withTenantContext`
transaction, not a plain query — means pool exhaustion surfaces as
Prisma's `P2028` ("unable to start a transaction"), not only `P2024`, and
`DbPoolExhaustionFilter` was fixed at the time to catch both. This
experiment proves that fix STILL holds, two ways: (1) drives the raw
Prisma client directly against a deliberately 1-connection pool and
asserts the real error genuinely is one of `P2024`/`P2028` — which of the
two fires is itself a real, confirmed-empirically race between Prisma's
own interactive-transaction `maxWait` and the driver-level
`pool_timeout`, not an assumption either way; (2) drives the identical
contention scenario through real HTTP and asserts a clean `503` with
`Retry-After` regardless of which code fired underneath, arriving well
before the holder's own multi-second delay would — never a hang, never a
raw `500`.

**Outcome**: held. No new weakness found — the 5.4 fix is confirmed
still correct against the current codebase.

**Verified locally**: both assertions pass against a real, deliberately
undersized (`DB_POOL_SIZE=1`) pool on the local Postgres instance.

### 3.3 BullMQ worker killed mid-job — `chaos-queue-worker-kill.e2e-spec.ts`

**What it does**: reuses the REAL payroll-run pipeline (2.1) rather than
inventing a new one. Unlike `payroll.e2e-spec.ts`'s own existing
"resumability" test (which proves a single BROKEN employee's computation
failure doesn't block the rest of a run — an error CAUGHT inside the
per-employee try/catch), this experiment simulates the WORKER PROCESS
ITSELF dying partway through the per-employee loop — an error that
ESCAPES `PayrollRunProcessor.process` entirely, uncaught, with some
employees already `COMPUTED` and others never even attempted, the exact
shape a real container SIGKILL mid-job produces. A simulated BullMQ
retry (re-invoking `process()` with the identical job data, exactly what
`attempts: 5` does for real) then completes the run.

**Outcome**: held — no weakness found. The two-layer idempotency
mechanism `PayrollRunProcessor` already documents (a Redis claim per
`<tenantId>:<runId>:<employeeId>`, plus `PayrollRunLine`'s own
`@@unique([tenantId, payrollRunId, employeeId])` as a database-layer
backstop) works exactly as designed: every employee `COMPUTED` before the
simulated kill has a byte-identical `computedAt` timestamp after the
retry (proof of no double-apply/no reprocessing), every employee is
`COMPUTED` exactly once by the end, and the run correctly reaches
`CALCULATED`.

**Verified locally**: against the real `PayrollEngineService`, real
Postgres transactions, and the real Redis-backed `IdempotencyService` —
only the single injected kill point (a monkey-patched private method) is
not the production code path; everything else is.

### 3.4 A request flood protects the real critical path — `chaos-flood-critical-path.e2e-spec.ts`

**What it does**: deliberately does NOT redo `edge-ddos-flood.e2e-spec.
ts`'s (6.3) own genuine-concurrent-flood proof against the demo routes —
that proof already stands and is reused, not repeated. This experiment
EXTENDS it one step further, onto a REAL production route
`resilience.md` itself names as needing to survive a flood:
`POST /auth/login` (`@Priority('CRITICAL')`). A genuine concurrent flood
of low-priority demo requests (large enough to observably trigger real
`503`s) is fired CONCURRENTLY with a batch of real login attempts against
distinct, nonexistent emails (chosen specifically to stay clear of
`AuthService`'s own separate per-email attempt limiter — a different
layer, proven elsewhere).

**Outcome**: held — no weakness found. Every login attempt received a
genuine auth outcome (`401`, since the emails don't exist) — never
`503` — even while the flood was actively shedding a large fraction of
the low-priority traffic around it. The system also recovered cleanly
once the flood subsided (an ordinary low-priority request immediately
succeeded again).

**Verified locally**: against real concurrent HTTP load (`Promise.all`
over dozens of in-flight requests) on the local stack, not a simulated
signal.

### 3.5 Real SIGTERM against a real spawned instance — `chaos-sigterm-drain.e2e-spec.ts`

**What it does**: the one experiment in this suite that spawns REAL,
SEPARATE OS processes — `node dist/main.js` (the exact artifact
`deploy/k8s/base/api-deployment.yaml` runs), two of them on distinct
ports, standing in for two real pods. `deployment-scaling.e2e-spec.ts`
(5.3) already proves statelessness across two `AppModule` COMPILATIONS
living in the SAME process, and `resilience.e2e-spec.ts` already proves
readiness flips the instant `ShutdownService.beginShutdown()` is called
directly — neither exercises `main.ts`'s own real
`process.on('SIGTERM', ...)` handler, which only runs when `main.ts`
itself boots a process. This experiment sends a REAL `SIGTERM` to one
spawned instance while a real HTTP request is genuinely in flight against
it, and separately confirms the untouched sibling instance keeps serving
throughout — as close to a real rolling-update pod eviction as this
sandboxed, single-machine, no-cluster environment can get.

**Outcome**: held — no weakness found. Readiness on the signaled instance
flips to `503` well before the grace period elapses (the load-balancer-
facing signal 5.3's rollout strategy depends on); the request that was
ALREADY in flight when `SIGTERM` arrived completes successfully — never
dropped or reset — because `main.ts` waits out
`SHUTDOWN_GRACE_PERIOD_MS` and then `app.close()`'s own `server.close()`
semantics drain it; after the grace period the process genuinely stops
accepting new connections; the sibling instance is completely unaffected
throughout and afterward.

**Verified locally**: a real child process, a real `SIGTERM`, a real
in-flight HTTP request across the signal, and a real second sibling
process observed unaffected — all on this local machine. **NOT verified
at this level**: an actual Kubernetes rolling update (a real
`PodDisruptionBudget`, a real `preStop` hook, a real load balancer
noticing readiness) — that remains 5.3's own honestly-stated
verified-at-deploy boundary; this experiment proves the APPLICATION-level
half of that story for real, not the orchestrator half.

## 4. Verified-locally vs. verified-at-deploy (this step's own split)

Following 5.3/6.3's own discipline exactly:

**Verified locally, for real, in this environment**: every chaos
experiment in § 3 (including two real process kills — a `redis-server`
child process and, separately, a real `node dist/main.js` OS process via
`SIGTERM`); the `hrm_redis_unavailable_fail_open_total` fix, proven by a
real test that kills real Redis; `DbPoolExhaustionFilter`'s `P2028`
handling, re-confirmed against a real exhausted pool; `ops/backup/
verify-latest-backup.sh` against a real backup artifact; the full
existing regression suite (§ 5) green end to end in the SAME session
these chaos tests were added and run in, on native Postgres 16/Redis 7
(this sandboxed environment has no Docker daemon available — see the
note below) plus a native PgBouncer (transaction-pooling) instance and a
real streaming Postgres read replica, both configured to match 5.1's own
docker-compose service shapes, and an S3-API-compatible mock (`s3rver`)
standing in for MinIO, since neither a Docker daemon nor network access
to download a real MinIO binary was available in this sandboxed session
— every OTHER piece of infrastructure (Postgres, Redis, the replica,
PgBouncer) is the genuine service, natively installed, not mocked.

**Explicitly NOT verified at this level, honestly, the same way 5.3/6.3
already draw this line for themselves**: an actual Kubernetes rolling
update/eviction (real `PodDisruptionBudget`s, a real load balancer); a
real second-region failover (no second region exists here); a real WAF/
CDN absorbing a volumetric flood before it reaches the app (6.3's own
already-stated boundary); a real ransomware scenario end to end (only its
constituent mechanisms — encrypted backups, immutable audit log — are
individually proven); ransomware-specific offsite bucket versioning/WORM
policy (flagged in § 2.3 as a deployment-time decision, not code this
repository configures).

## 5. Full-suite verification

Run fresh in the SAME session these chaos tests were written, per this
project's own "genuine, not assumed" verification discipline (see the
6.1/6.2/6.3 build-log entries this mirrors):

- `pnpm build` — 6/6 workspace tasks green (all four apps + `@hrm/db` +
  `@hrm/shared`).
- `pnpm lint` — 8/8 workspace tasks green.
- `pnpm test -- -- --runInBand` — the FULL suite (every workspace:
  `@hrm/db`, `@hrm/api` including the five new chaos files above,
  `@hrm/mobile`) green. See the matching entry in
  [`docs/BUILD_LOG.md`](../BUILD_LOG.md) for the exact pass count.

See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)'s own 6.4 entry for the exact
numbers and the local-infrastructure notes (native Postgres/Redis/
PgBouncer/replica plus the S3-mock substitution) this verification
actually ran against.
