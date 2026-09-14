# HRM — Kubernetes deployment (Phase 5.3)

See [`docs/conventions/deployment-scaling.md`](../../docs/conventions/deployment-scaling.md)
for the full write-up (statelessness proof, the api/worker split, HPA
signals, the regional-deployment model). This file is the operational
how-to: what to apply, in what order, and how a release actually rolls
out.

## Layout

```
deploy/k8s/
  base/                        # every resource, region-agnostic defaults
    namespace.yaml
    configmap.yaml              # hrm-api-config — non-secret env
    secret.example.yaml         # hrm-api-secrets — TEMPLATE, do not apply as-is
    license-public-key-configmap.yaml
    api-deployment.yaml         # + the PROCESS_ROLE=api env var
    api-service.yaml
    api-hpa.yaml                 # CPU/memory (works with just metrics-server)
    worker-deployment.yaml      # same image, command: dist/worker.js
    worker-hpa-fallback.yaml    # CPU-based; apply this OR worker-hpa-keda.yaml
    worker-hpa-keda.yaml        # queue-depth based (requires the KEDA add-on) — NOT in kustomization.yaml's default resource list, add explicitly
    pdb.yaml                    # PodDisruptionBudgets, all 4 workloads
    portal-deployment.yaml      # + its own ConfigMap/Secret/Service/HPA
    admin-deployment.yaml       # + its own ConfigMap/Service
    ingress.yaml
    migration-job.yaml          # applied SEPARATELY by the pipeline, not part of kustomization.yaml (see below)
    kustomization.yaml
  overlays/
    us-east-1/kustomization.yaml
    me-south-1/kustomization.yaml
```

## Prerequisites (add-ons this manifest set assumes, but does not install)

- An ingress controller (nginx assumed by `ingress.yaml`'s annotations).
- `metrics-server` (for `api-hpa.yaml`/`worker-hpa-fallback.yaml`'s CPU/memory metrics — ships by default on most managed clusters, e.g. EKS/GKE/AKS).
- `cert-manager` with a `ClusterIssuer` named `letsencrypt-prod`, if you want the `ingress.yaml` TLS annotations to actually provision certificates (otherwise remove the annotation and manage TLS another way).
- **Optional**: [KEDA](https://keda.sh) if you want queue-depth-based worker autoscaling (`worker-hpa-keda.yaml`) instead of the CPU-based fallback.
- Postgres 16 + PgBouncer + (optionally) a read replica, Redis, and an S3-compatible bucket — either managed services or the in-cluster equivalents from the root `docker-compose.yml`, translated to your cluster's own StatefulSets/operators. This manifest set does not provision the data layer itself (see [`scaling-data-layer.md`](../../docs/conventions/scaling-data-layer.md)) — only points the app at it via `hrm-api-secrets`.

## First-time setup

```bash
kubectl apply -f base/namespace.yaml

# Replace secret.example.yaml's placeholders with real values via your
# cluster's own secret-management tooling — never apply the example file
# verbatim. E.g., with plain kubectl:
kubectl create secret generic hrm-api-secrets -n hrm \
  --from-literal=DATABASE_URL=... \
  --from-literal=APP_DATABASE_URL=... \
  --from-literal=REDIS_URL=... \
  --from-literal=REDIS_PASSWORD=... \
  --from-literal=JWT_SECRET=... \
  --from-literal=JWT_REFRESH_SECRET=... \
  --from-literal=PLATFORM_JWT_SECRET=... \
  --from-literal=FIELD_ENCRYPTION_KEY=... \
  --from-literal=S3_ACCESS_KEY_ID=... \
  --from-literal=S3_SECRET_ACCESS_KEY=... \
  --from-literal=STRIPE_SECRET_KEY=... \
  --from-literal=STRIPE_WEBHOOK_SECRET=...

kubectl create secret generic hrm-portal-secrets -n hrm \
  --from-literal=NEXTAUTH_SECRET=...
```

## Deploy pipeline (migration safety + zero-downtime rollout)

**Migrations run ONCE, from a single Job — never per-pod, never as part of
a Deployment's own startup.** This is the load-bearing ordering constraint
this whole pipeline exists to enforce:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD)

# 1. Build & push (same image serves api, worker, AND the migration Job —
#    see apps/api/Dockerfile's header comment).
docker build -f apps/api/Dockerfile -t "registry/hrm-api:${IMAGE_TAG}" .
docker push "registry/hrm-api:${IMAGE_TAG}"
docker build -f apps/portal/Dockerfile -t "registry/hrm-portal:${IMAGE_TAG}" .
docker push "registry/hrm-portal:${IMAGE_TAG}"
docker build -f apps/admin/Dockerfile -t "registry/hrm-admin:${IMAGE_TAG}" .
docker push "registry/hrm-admin:${IMAGE_TAG}"

# 2. Run the migration Job for THIS release and WAIT for it to complete
#    before touching any Deployment. `envsubst` fills in ${IMAGE_TAG} (the
#    Job's name AND its image tag) — plain manifests have no native
#    templating for this, unlike a Helm pre-upgrade hook.
export IMAGE_TAG
envsubst < base/migration-job.yaml | kubectl apply -f -
kubectl wait --for=condition=complete "job/hrm-api-migrate-${IMAGE_TAG}" -n hrm --timeout=300s
# A failed/timed-out migration STOPS the pipeline here — never roll
# application images forward against a schema they don't match.

# 3. Roll the application Deployments — readinessProbe gates traffic,
#    maxUnavailable: 0 means capacity never drops, PodDisruptionBudgets
#    protect against a concurrent voluntary disruption (e.g. a node drain)
#    compounding with the rollout itself.
kubectl set image deployment/hrm-api api="registry/hrm-api:${IMAGE_TAG}" -n hrm
kubectl set image deployment/hrm-worker worker="registry/hrm-api:${IMAGE_TAG}" -n hrm
kubectl set image deployment/hrm-portal portal="registry/hrm-portal:${IMAGE_TAG}" -n hrm
kubectl set image deployment/hrm-admin admin="registry/hrm-admin:${IMAGE_TAG}" -n hrm

kubectl rollout status deployment/hrm-api -n hrm
kubectl rollout status deployment/hrm-worker -n hrm
kubectl rollout status deployment/hrm-portal -n hrm
kubectl rollout status deployment/hrm-admin -n hrm
```

**Rollback**: `kubectl rollout undo deployment/hrm-api -n hrm` (etc.) rolls
the application back to the previous image. A migration is NOT
automatically reversed — same posture as `prisma migrate deploy`
everywhere else in this codebase; a backward-incompatible migration needs
its own hand-written down-migration before a rollback is safe, exactly
the same rule that already applies to every non-containerized deployment
of this app.

**Why a Job, not a Helm hook or an initContainer on every api pod**: an
initContainer-per-pod would run the SAME migration once per replica
(harmless for `prisma migrate deploy`, which is itself idempotent/
advisory-locked — but wasteful, and racy if a rollout briefly runs old and
new images side by side against a mid-migration schema). A single Job,
waited on BEFORE the Deployment rollout starts, is the simplest correct
ordering with plain manifests (no Helm chart in this repo — see
[`docs/conventions/deployment-scaling.md`](../../docs/conventions/deployment-scaling.md)
for why plain manifests were chosen over a Helm chart for this step).

## Regional deployment

```bash
# Build once per region — each is a genuinely separate manifest set
# pointed at that region's own data layer (see deployment-scaling.md §
# Regional deployment for the full tenant->region placement model).
kubectl apply -k overlays/us-east-1
kubectl apply -k overlays/me-south-1
```

Each overlay is applied to its OWN cluster in the common case (one
cluster per region, for genuine data-residency isolation) — `kubectl
apply -k` against two different `kubeconfig` contexts, not two namespaces
in one cluster. See `overlays/us-east-1/kustomization.yaml`'s own header
comment for the one (uncommon) exception: a single cluster spanning
multiple regions' own node pools, which the `nodeSelector` patch also
supports.

## What's verified locally vs. at deploy time

| Claim                                                                                                           | Verified how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API/worker hold no in-process cross-request state (statelessness)                                               | `apps/api/test/deployment-scaling.e2e-spec.ts` — two independent `AppModule` instances share rate-limit/idempotency/circuit-breaker state via Redis; a JWT issued for one authenticates on the other. **Verified locally.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PROCESS_ROLE=api` stops a process from consuming BullMQ jobs; a separate worker still does                     | Same file — a real BullMQ `Worker` with `autorun:false` never touches an enqueued job; a second, plain `Worker` on the same queue/Redis picks it up. **Verified locally.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Graceful shutdown drains in-flight work                                                                         | `apps/api/test/resilience.e2e-spec.ts`'s readiness tests (0.10) — `/health/ready` flips unhealthy the instant `ShutdownService.beginShutdown()` is called. **Verified locally.** The k8s-specific half (preStop sleep giving endpoint-removal time to propagate BEFORE SIGTERM) is a standard, well-documented pattern but requires a real Service/Endpoints controller to observe — **verified at deploy time.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Manifests are structurally valid                                                                                | `kustomize build base`, `overlays/us-east-1`, `overlays/me-south-1` all render successfully (kustomize v4.5.4); every rendered document has a valid `apiVersion`/`kind`. **Verified locally.** A full `kubectl apply --dry-run=server` (which validates against a real API server's OpenAPI schema, catching anything kustomize's offline render can't) and `helm lint`-equivalent policy checks (e.g. `kubeconform`, `kube-score`) were NOT run — no live cluster or those specific binaries were available in this environment. **Verified at deploy time.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Docker images build AND run correctly                                                                           | `docker build` was run for `apps/api/Dockerfile` against this repo directly — both `dist/main.js` and `dist/worker.js` are present in the built image. The image was then actually RUN (not just built) as both the API and the worker, `--network host` against this environment's real docker-compose Postgres/Redis: both entrypoints' `/health/live` and `/health/ready` answered healthy. This caught a real bug — the first build crashed on boot (`Prisma cannot find libssl.so.1.1` — Debian bookworm ships OpenSSL 3.0, not 1.1, and Prisma's auto-detection guesses 1.1.x when `openssl` isn't installed anywhere in the image) — fixed by installing `openssl`/`ca-certificates` in the Dockerfile's `base` stage. `apps/portal`/`apps/admin` Dockerfiles were validated for build-output shape (not run as containers): `next build` (with `output: 'standalone'`) was run directly and its output directory structure matches exactly what each Dockerfile's `COPY` steps expect. **Verified locally** — both the api/worker image build AND runtime boot; portal/admin build-shape only. |
| HPA scaling actually triggers, KEDA queue-depth scaling works, multi-region routing/DNS/cert provisioning works | These require a running cluster (kubelet, metrics-server/KEDA, a real ingress controller, DNS) that does not exist in this environment. **Verified at deploy time only** — the manifests encode the intended behavior and are structurally sound, but triggering an actual scale-up/scale-down event, or a cert-manager certificate issuance, was not (and could not be) exercised here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
