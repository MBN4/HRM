# Horizontal scaling, Kubernetes, and regional deployment

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 5.3 (Phase 5's third slice) — `apps/api/src/worker.ts`,
`apps/api/src/queue/queue-worker.util.ts`, `apps/api/Dockerfile`,
`apps/portal/Dockerfile`, `apps/admin/Dockerfile`, `deploy/k8s/`,
`docker-compose.scale.yml`, `apps/api/test/deployment-scaling.e2e-spec.ts`.
Builds directly on [resilience.md](./resilience.md) (the 0.10 chassis this
step confirms is genuinely stateless, and extends nothing about),
[scaling-data-layer.md](./scaling-data-layer.md) (the data-layer topology
every pod in this step's manifests connects to),
[tenant-resolution.md](./tenant-resolution.md) (the per-request transaction
model + `Tenant.hostingRegion`, which drives this step's regional-placement
model), [tenancy-rls.md](./tenancy-rls.md),
[notifications-queues.md](./notifications-queues.md) (the `QueueModule`
pattern every BullMQ processor in this codebase already follows, and which
this step's worker/API split depends on), and
[partitioning-archival.md](./partitioning-archival.md) (one more scheduled
job now running only in the worker Deployment). **This is a deployment-
oriented step: the goal is a provably horizontally scalable application
(real, testable) plus production-ready orchestration — not a rewrite of
any business logic.** Every claim below is marked verified-locally or
verified-at-deploy; see `deploy/k8s/README.md`'s own table for the
consolidated version of that split.

## 1. Statelessness — audited, not assumed

Every piece of cross-request state the 0.10 resilience chassis, auth, and
tenancy layers use already lived in Redis or Postgres BEFORE this step —
this step's job was to confirm that by actually looking, not to add
Redis-backing that was missing. The audit (`grep` across `apps/api/src`
for `new Map(`, `private.*cache`, `setInterval`, and every `onModuleInit`)
found exactly two pieces of in-process state, both already reviewed and
harmless, plus one demo-only piece worth naming honestly:

- **`SystemLoadService`'s in-flight-request counter** (0.10) — the ONE
  deliberate, already-documented exception (see
  [resilience.md](./resilience.md) → Load shedding): load shedding
  protects THIS process's own resources, which is inherently per-instance
  by design. Unchanged by this step.
- **`LicenseVerificationService.publicKeyCache`** (0.6) — memoizes a
  `readFileSync` of the license public-key file. This is NOT cross-request
  _coordination_ state (nothing about it needs to agree across instances)
  — it is a per-process memoization of an IMMUTABLE input every instance
  reads from the identical mounted file (see
  `deploy/k8s/base/license-public-key-configmap.yaml` — the same
  `ConfigMap`, volume-mounted identically onto every api/worker pod).
  Reviewed and left unchanged: caching an immutable, identically-mounted
  file is safe under horizontal scaling by construction, not merely by
  omission.
- **`ResilienceDemoController.idempotentCounters`** (0.10's own proof/demo
  surface, never real business logic) — a per-controller-instance
  in-memory `Map`. Worth naming plainly rather than glossing over: on a
  genuinely NEW `Idempotency-Key`, this counter would start over on
  whichever instance handles that first call, independent of any other
  instance's own counter. This never actually surfaces as a bug, though,
  because of WHAT the counter is used to prove: a REPLAY of an
  already-`COMPLETED` key never reaches this Map at all —
  `IdempotencyInterceptor` returns the Redis-cached response before the
  handler method is ever invoked (see `IdempotencyService.execute`'s own
  doc comment). `deployment-scaling.e2e-spec.ts`'s own idempotency test
  proves exactly this by claiming a key on one instance and replaying it
  on a completely separate one. No real route in this codebase follows the
  demo controller's in-memory-counter pattern — it exists solely so the
  resilience demo has something observable to assert on.
- Every repeatable BullMQ job (`PartitionMaintenanceService`,
  `AnalyticsRollupService`, LMS's rollup/expiry jobs, ...) registers with a
  FIXED `jobId` from `onModuleInit` — already documented at each call site
  as "idempotent re-registration." This step's contribution is naming WHY
  that matters for horizontal scaling specifically: every worker replica's
  own `onModuleInit` calls `queue.add(..., { repeat, jobId: FIXED })`
  independently, and BullMQ recognizes the same `jobId` as the same
  scheduled job — running N worker replicas registers the SAME one
  repeatable job N times, a no-op after the first, never N duplicate
  schedules. Nothing to change here; this was already correct.

**Proven, not just argued**:
`apps/api/test/deployment-scaling.e2e-spec.ts` compiles TWO fully separate
`AppModule` instances (two distinct DI containers/object graphs — the
closest a Jest test gets to "two pods" without spawning two OS processes)
and shows a JWT issued for instance A authenticates on instance B, a
per-tenant rate-limit quota consumed via instance A is enforced on
instance B, an idempotency key claimed on instance A replays its cached
result on instance B, and a circuit breaker tripped via instance A is
already `OPEN` on instance B's very first call — all four exercised
against REAL Redis, not mocked. **Verified locally.**

## 2. Separate scalable workloads — API vs. worker

Before this step, EVERY `@Processor(...)` BullMQ worker (16 of them, one
per queue — payroll runs, notifications, imports, statutory reports,
partition maintenance/archival, ...) was registered inside the same
feature module as its own HTTP controller, and `apps/api/src/main.ts` was
the only entrypoint — meaning the API process always also consumed every
queue. Splitting this into two truly independent, independently-scalable
deployables took two pieces:

- **`apps/api/src/worker.ts`** — a SECOND entrypoint,
  `NestFactory.createApplicationContext(AppModule)` instead of
  `NestFactory.create(AppModule)`. This instantiates the EXACT same DI
  graph as the API (every processor registers and is ready to consume its
  queue) but binds NO HTTP listener and mounts none of `AppModule`'s ~30
  feature controllers — a genuinely smaller process, not the same one with
  routes politely ignored. A minimal, hand-rolled `http.createServer` (NOT
  `AppModule`'s own `HealthController`, which is wired through the full
  HTTP app's interceptor stack that doesn't exist here) exposes
  `/health/live`/`/health/ready` for a kubelet probe, calling
  `ReadinessService`/`ShutdownService` directly — reusing 0.10's real
  DB/Redis/shutdown-flag checks, zero new health logic. SIGTERM handling
  mirrors `main.ts` exactly: flip readiness unhealthy, wait
  `SHUTDOWN_GRACE_PERIOD_MS`, THEN `context.close()` — which runs every
  module's `onModuleDestroy`/`onApplicationShutdown` (including
  `@nestjs/bullmq`'s own `WorkerHost` shutdown hook, which waits for any
  currently-active job to finish) exactly as `app.close()` does, since
  Nest's lifecycle hooks aren't specific to `INestApplication` vs.
  `INestApplicationContext`.
- **`apps/api/src/queue/queue-worker.util.ts`** (`shouldAutorunWorkers()`)
  — the piece that stops the API Deployment from ALSO consuming queues
  once a separate worker exists. Every one of the 16 `@Processor(QUEUE,
...)` call sites now passes `{ autorun: shouldAutorunWorkers() }` — a
  plain BullMQ `WorkerOptions` field. `shouldAutorunWorkers()` returns
  `false` only when `process.env.PROCESS_ROLE === 'api'` (set on the `api`
  Deployment, see `deploy/k8s/base/api-deployment.yaml`); the worker
  Deployment sets no `PROCESS_ROLE` at all, so it defaults to `true` there
  (and in every existing dev/test/e2e invocation — this is 100%
  backward-compatible, unset is the pre-existing behavior). `autorun:
false` still CONSTRUCTS the underlying BullMQ `Worker` (so DI/module
  wiring is completely unaffected) — it just never starts pulling jobs off
  Redis, exactly as if the process had no processor for that queue at all.

**Why this shape, not a per-module code split**: every feature module in
this codebase bundles its controller and its processor together (e.g.
`PayrollModule` owns both `PayrollController` and `PayrollRunProcessor`).
Splitting that apart into separate "API module" / "worker module" pairs
per feature would touch all 16 queue-owning modules for a purely
structural gain `PROCESS_ROLE`/`autorun` already delivers with a 1-line
change per file: whether a given PROCESS actually pulls jobs, independent
of which controllers/providers happen to be compiled into it. The
DI-graph size difference between "full AppModule, autorun off" (api
Deployment) and "full AppModule, autorun on, no HTTP" (worker Deployment)
is a few dozen extra provider instantiations at boot — not a runtime cost
that scales with load — so this was the honest trade: real behavioral
independence (provably: see below) without an oversized refactor of every
existing feature module.

**Proven, not just argued**:
`deployment-scaling.e2e-spec.ts`'s second `describe` block constructs a
REAL BullMQ `Worker` with `autorun: false` (exactly what `PROCESS_ROLE=api`
produces) against a throwaway queue, enqueues a job, and confirms it sits
`waiting` untouched — then brings up a second, plain `Worker` (`autorun`
at its BullMQ default of `true`, standing in for the dedicated `worker`
process) on the SAME queue/Redis connection and confirms it picks the job
up and completes it. This is testing the real library's documented
behavior under our actual wiring, not re-asserting our own code compiles.
**Verified locally.**

`apps/api/src/queue/queue-worker.util.spec.ts` unit-tests
`shouldAutorunWorkers()` itself (3 tests: `PROCESS_ROLE=api` → `false`;
unset → `true`; any other value → `true`).

## 3. Docker images

- **`apps/api/Dockerfile`** — ONE image for both the API and the worker
  (and, additionally, the one-shot migration Job — see § 5). Multi-stage,
  `turbo prune`-based (this is a pnpm+Turborepo monorepo — see CLAUDE.md §
  3): stage 1 computes the minimal pruned subset of the monorepo `@hrm/api`
  actually needs; stage 2 installs (from `out/json`, so Docker layer
  caching survives source edits that don't touch a dependency) and builds
  (`prisma generate` runs INSIDE this stage, never copied from the host —
  its query-engine binary must match the container's own OS/libc, the same
  "native" default `packages/db/prisma/schema.prisma` already uses
  locally); stage 3 is the runtime image. `node:20-bookworm-slim` (Debian,
  not Alpine) is a deliberate choice: `@node-rs/argon2` (password hashing,
  see [auth-rbac.md](./auth-rbac.md)) and Prisma's query engine both ship
  prebuilt binaries keyed to glibc by default, and Alpine's musl libc is a
  real, well-known source of "works locally, breaks in the container"
  failures for exactly these two dependencies — reliability over image
  size, consistent with this codebase's "prove it directly" discipline
  elsewhere. `CMD` defaults to `node dist/main.js`; the worker Deployment
  overrides `command:` to `node dist/worker.js` — same image, different
  entrypoint, exactly what makes "same business logic, genuinely separate
  deployable" true rather than a documentation claim. A deliberate, named
  simplification: the runtime image also carries `packages/db`'s
  `prisma` CLI devDependency (needed by the migration Job's
  `prisma migrate deploy`) rather than maintaining a FOURTH, separate
  "migrator" image just to trim it — documented in the Dockerfile itself,
  not silently accepted.
- **`apps/portal/Dockerfile`** / **`apps/admin/Dockerfile`** — the same
  `turbo prune` shape, `node:20-alpine` (no native-binary dependencies in
  either app — pure JS/TS, unlike the API), and Next.js's own documented
  `output: 'standalone'` build (a new, additive line in each app's
  `next.config.js` — `next dev`/`next start` are unaffected, this only
  changes what `next build` additionally emits) traced into a minimal
  runtime image.

**A real bug this step's own smoke test caught before it shipped**: the
first working build of `apps/api/Dockerfile` produced an image that
crashed immediately on `docker run`, with `PrismaClientInitializationError:
... Prisma cannot find the required libssl system library ... libssl.so.1.1:
cannot open shared object file`. Root cause: with no `openssl` package
installed anywhere in the image, Prisma's OS/libc auto-detection (run once
at `prisma generate` time in the `installer` stage, and consulted again by
the generated engine at actual runtime) falls back to guessing
`debian-openssl-1.1.x` — but `node:20-bookworm-slim` (Debian 12) ships
OpenSSL 3.0 by default, which has no `libssl.so.1.1` at all. The fix:
`apt-get install -y openssl ca-certificates` in the shared `base` stage,
so BOTH the generate-time detection AND the runtime library presence agree
on OpenSSL 3.0.x. This is a well-known, easy-to-miss Prisma-in-Docker
gotcha, caught here specifically BECAUSE this step insisted on actually
running the built container against real Postgres/Redis rather than
stopping at "the build succeeded."

**Verified locally, end to end, against real infra — not just a
successful build**: `docker build -f apps/api/Dockerfile .` was run
directly against this repo; the built image contains both `dist/main.js`
and `dist/worker.js`. BOTH entrypoints were then actually started as
running containers (`docker run`, `--network host`) against this
environment's real `docker-compose` Postgres and Redis: the API container
answered `GET /health/live` (`{"status":"ok"}`) and `GET /health/ready`
(`{"ready":true,"checks":{"database":true,"redis":true,"shuttingDown":false}}`)
correctly; the worker container (`command: node dist/worker.js`) logged
`"HRM worker process started — consuming all registered BullMQ queues."`
and `"Worker health server listening on port 3098"`, and its own
`/health/live`/`/health/ready` (on the separate worker health port)
answered identically healthy. `next build` (with `output: 'standalone'`
newly enabled) was run directly for both `apps/portal`/`apps/admin` and
produced exactly the `.next/standalone/apps/<app>/server.js` layout each
Dockerfile's `COPY` steps assume — confirmed by inspecting the actual
build output directory, not assumed from Next.js's documentation alone.

## 4. Kubernetes manifests

Plain manifests (`deploy/k8s/base/*.yaml` + Kustomize overlays for
regions), not a Helm chart — a deliberate choice for this step: this
repo ships no Helm chart anywhere yet, and introducing one is a bigger,
separate investment (a `values.yaml` schema, template functions, a chart
version) than this step's actual deliverable (real, correct, reviewable
orchestration) required. Kustomize overlays (§ 6) get the "same base,
per-environment differences" benefit Helm's `values.yaml` provides,
without a templating engine on top of YAML — every rendered manifest is
still literal, `kubectl`-readable YAML, and Kustomize ships built into
`kubectl` itself (`kubectl apply -k`).

- **`api-deployment.yaml`** — `PROCESS_ROLE=api`; readiness/liveness wired
  to 0.10's real `/health/live`/`/health/ready`; `RollingUpdate` with
  `maxUnavailable: 0` (zero-downtime); a `preStop: sleep 5` complementing
  (not replacing) the app's OWN SIGTERM-driven drain — the well-known gap
  between "pod marked Terminating" and "kube-proxy/ingress has actually
  stopped routing here" that a preStop sleep exists to cover, BEFORE
  SIGTERM (and the app's own readiness-flip) is even sent;
  `terminationGracePeriodSeconds: 35` sized to comfortably exceed that
  sleep plus `SHUTDOWN_GRACE_PERIOD_MS` (20s in the shipped ConfigMap).
- **`worker-deployment.yaml`** — no `PROCESS_ROLE` (the default — consumes
  queues); no ports exposed via a Service (nothing calls a worker pod
  directly); a longer `terminationGracePeriodSeconds: 60`, since a job
  already in flight (a payroll run, a report generation) should be allowed
  to actually finish, not just drain an HTTP connection.
- **`api-hpa.yaml`** — CPU (70% average utilization) + memory (80%),
  works with just `metrics-server`, no extra add-on. A commented-out
  `Pods` metric block documents the latency-based alternative (needs a
  Prometheus Adapter or equivalent custom-metrics API — not exercisable in
  this environment, correctly deferred to 5.4 observability rather than
  shipped as a silently-nonfunctional metric type).
- **`worker-hpa-keda.yaml`** — the PREFERRED signal for the worker: queue
  depth, via [KEDA](https://keda.sh)'s `redis` scaler reading BullMQ's own
  `bull:<queue>:wait` list length directly. One `ScaledObject`, multiple
  triggers (KEDA scales to satisfy whichever trigger wants the most
  replicas) — shown for a representative subset of queues
  (`payroll-run`, `notifications`, `statutory-report`,
  `employee-import`); adding a trigger for any other queue is a 6-line
  copy-paste, nothing else changes. Requires the KEDA operator installed
  in-cluster (an add-on, not provisioned by this repo) — **NOT** included
  in `base/kustomization.yaml`'s default resource list for exactly that
  reason (applying it against a cluster with no KEDA CRDs would fail); an
  operator adds it explicitly once KEDA is installed.
- **`worker-hpa-fallback.yaml`** — plain CPU-based HPA for a cluster
  without KEDA, so the worker Deployment is never left with NO autoscaling
  at all. Apply this OR the KEDA one, never both (same `scaleTargetRef`).
- **`pdb.yaml`** — `PodDisruptionBudget`s for all four workloads, so a
  voluntary disruption (a node drain) can't take down more replicas at
  once than the app can tolerate — orthogonal to, and doesn't replace, the
  HPA's own replica count.
- **`ingress.yaml`** — see its own header comment for the PRODUCTION
  hostname/path convention this step chose, deliberately different from
  local dev's raw-port setup: portal and api share ONE host per tenant
  (`<slug>.yourhrms.com`, reusing 0.3's subdomain strategy completely
  unmodified) split by PATH (`/api/*` → api, rewritten to strip the
  prefix; everything else → portal) rather than by port, since exposing a
  raw alternate port through a real ingress/load balancer is unusual in
  production. `admin.yourhrms.com` is a separate, fixed hostname — the
  vendor console has no tenant/subdomain concept at all (see
  [vendor-console.md](./vendor-console.md)). This is ONE reasonable
  topology, not a re-architecture of 0.3/1.4's own tenant-resolution
  design — a real deployment's exact hostname/path split is a DNS/ingress
  decision made at deploy time, matched by that Next.js build's own
  `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_TENANT_BASE_DOMAIN` env values (a
  build-time config choice, not a code change).
- **`migration-job.yaml`** — see § 5.

**Verified locally**: `kustomize build base`, `overlays/us-east-1`, and
`overlays/me-south-1` all render successfully (kustomize v4.5.4, fetched
via `npx`), and every rendered document carries a valid `apiVersion`/
`kind`. **Verified at deploy time**: `kubectl apply --dry-run=server`
against a real API server (validates against that server's actual OpenAPI
schema — catches more than an offline kustomize render can), a live HPA
scale-up/scale-down event actually triggering, and a live ingress/
cert-manager certificate issuance — none of these are exercisable without
a running cluster, which this environment does not have.

## 5. DB migration safety in the deploy pipeline

Migrations run from a single `Job` (`migration-job.yaml`), applied and
WAITED ON (`kubectl wait --for=condition=complete`) BEFORE any api/worker
Deployment is rolled to a new image — never as a per-pod initContainer
(which would run the same migration once per replica: harmless for
`prisma migrate deploy`'s own idempotent/advisory-locked behavior, but
wasteful, and racy if a rolling update briefly runs old and new pods
against a mid-migration schema) and never baked into `main.ts`/
`worker.ts`'s own startup (which would run it on every single pod restart,
including a routine crash-loop recovery, not just an intentional release).
See `deploy/k8s/README.md` § Deploy pipeline for the exact command
sequence and rollback posture (an application image rollback is a plain
`kubectl rollout undo`; a migration is not automatically reversed — the
same rule that already applies to every non-containerized deployment of
this app).

## 6. Regional deployment — the data-residency SEAM, not enforcement

`Tenant.hostingRegion` (a plain string column, e.g. `us-east-1`,
`me-south-1`) and `CountryPack.hostingRegionHint` (advisory only — see
[country-packs.md](./country-packs.md)) both already existed before this
step, set by `PlatformTenantService` at tenant creation and displayed/
edited in the vendor console (see [vendor-console.md](./vendor-console.md)
§ Tenant lifecycle) — but nothing in this codebase actually ROUTED or
PLACED anything based on either value until now. This step adds the
deployment MECHANISM; it deliberately does NOT add automatic request-level
enforcement (rejecting/redirecting a request that reaches the "wrong"
region for a tenant) — that is honestly scoped to Phase 6.1, the exact
same "seam now, enforcement later" boundary
[partitioning-archival.md](./partitioning-archival.md) already draws for
`TenantRetentionOverride`.

**The model**:

- **Each region is a fully separate, shared-nothing stack** — its own
  Postgres (+ PgBouncer + optionally a replica), Redis, and S3 bucket, its
  own `deploy/k8s/overlays/<region>/` manifest set, deployed to its own
  cluster in the common case (genuine data-residency isolation — a
  region's tenants' rows never live in another region's database at all,
  never a single global database logically partitioned by a region
  column). `overlays/us-east-1/`/`overlays/me-south-1/` patch the handful
  of values that must differ per region: `TENANT_BASE_DOMAIN` (so a
  region's own subdomain wildcard is distinct — `acme.us.yourhrms.com` vs.
  `acme.me.yourhrms.com`), `S3_REGION`/`S3_ENDPOINT`/`S3_BUCKET`, and the
  ingress hostnames/TLS hosts. A `topology.hrm/region` label plus an
  OPTIONAL `nodeSelector` patch support the less common case of one
  cluster spanning multiple regions' own node pools — not load-bearing for
  isolation either way; the separate database/bucket per region is what
  actually isolates the data.
- **Tenant→region pinning reuses 0.3's tenant-resolution mechanism
  UNCHANGED**: because each region has its OWN `TENANT_BASE_DOMAIN`, the
  moment a tenant is provisioned in (say) `me-south-1`, its subdomain URL
  is region-specific BY CONSTRUCTION — `acme.me.yourhrms.com` only ever
  resolves against `me-south-1`'s own deployment, because THAT deployment
  is the only one configured with `TENANT_BASE_DOMAIN=me.yourhrms.com` at
  all (see [tenant-resolution.md](./tenant-resolution.md) — the subdomain
  strategy is unmodified by this step, just deployed once per region with
  a different config value). A branded custom-domain tenant (4.3, see
  [white-label.md](./white-label.md)) points its own DNS CNAME at whichever
  region's ingress load balancer its tenant was provisioned in — again a
  DNS-level, operational pinning decision, not application code.
- **Provisioning discipline, stated plainly as an operational convention,
  not enforced by the platform today**: a platform admin creating a new
  tenant via the vendor console (4.1) must target that REGION's own
  `@PlatformRoute()` API endpoint (e.g. `https://platform.us.yourhrms.com`
  for a US tenant) — `PlatformTenantService.create` writes
  `Tenant.hostingRegion` into whichever region's OWN database it's talking
  to, so provisioning against the correct region's endpoint is what
  actually determines residency; there is no single global control plane
  today that reads `hostingRegion` and automatically routes the CREATE
  call to the right region's database for you. This is the honest boundary
  this step draws, matching how `TenantRetentionOverride` was scoped in
  5.2: the field and the deployment mechanism are real and working; a
  platform-wide automatic-enforcement layer is Phase 6.1.

**Verified locally**: both region overlays render correctly via
`kustomize build` (confirmed: `TENANT_BASE_DOMAIN`, ingress hosts, and
`nodeSelector` all patch to the expected per-region values — inspected
directly in the rendered output, not just assumed from the patch syntax).
**Verified at deploy time**: actual cross-region isolation (two real,
separately-provisioned regional stacks with genuinely non-interfering
data), DNS resolution of each region's wildcard subdomain, and a real
custom-domain CNAME pointed at a specific region's ingress — none of these
exist to exercise in this environment.

## 7. Scope discipline — what this step did NOT touch

RLS policies, `withTenantContext`'s mechanism, `TenantScopeInterceptor`'s
resolution/auth/rate-limit/load-shedding ordering, every existing
business-logic service, and every existing route's HTTP contract are all
completely unmodified. The 15 processor files' only change is one
constructor-option argument (`{ autorun: shouldAutorunWorkers() }`) added
to their existing `@Processor(...)` decorator call — no processing logic
inside any of them changed. `packages/db` gained no schema/migration
change at all (this step is infrastructure/deployment, not data model).

## Verification

- `apps/api`: full suite green — **549 total (548 passing + the SAME
  single pre-existing `migration.e2e-spec.ts` timing flake this suite has
  carried since 5.1** (see [scaling-data-layer.md](./scaling-data-layer.md)
  and every subsequent step's own BUILD_LOG entry) — confirmed unrelated
  to this step by an isolated rerun passing 10/10 cleanly. Includes 5 new
  tests in `deployment-scaling.e2e-spec.ts` and 3 new in
  `queue-worker.util.spec.ts`.
- Full-repo `pnpm build`/`pnpm lint` green across every workspace,
  including the newly-enabled `output: 'standalone'` Next.js builds for
  `apps/portal`/`apps/admin`.
- `docker build -f apps/api/Dockerfile .` succeeds against this repo
  directly; the resulting image contains both `dist/main.js` and
  `dist/worker.js`.
- `kustomize build` succeeds for `base/`, `overlays/us-east-1/`, and
  `overlays/me-south-1/`; every rendered manifest is well-formed YAML with
  a valid `apiVersion`/`kind`.
- `docker compose -f docker-compose.yml -f docker-compose.scale.yml
config -q` validates the optional local multi-instance demo overlay
  (two api containers + a worker + a round-robin nginx LB, sharing the
  root compose file's Postgres/Redis/MinIO) — a MANUAL demo for a human to
  drive, not part of the automated suite (the automated multi-instance
  proof is `deployment-scaling.e2e-spec.ts`, § 1).
- `apps/portal`/`apps/admin` Playwright suites: untouched — this step adds
  no UI surface and changes no application behavior either app's own
  tests exercise (only build output shape, via `output: 'standalone'`).
