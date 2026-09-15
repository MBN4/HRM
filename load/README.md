# HRM — Load testing (k6)

See [`docs/conventions/observability-load.md`](../docs/conventions/observability-load.md)
for the full write-up — the scenarios here, what was measured, the real
bottleneck found and fixed (payroll's per-employee component-definition
re-fetch), and the honest extrapolation toward the 20M-user target.

## Prerequisites

```bash
docker compose up -d postgres redis minio
pnpm --filter @hrm/db exec prisma migrate deploy
```

## 1. Seed realistic multi-tenant data

```bash
cd apps/api
pnpm run seed:load-test
```

Creates 10 tenants with a REALISTIC, skewed size distribution — 2 "whale"
tenants (300 and 200 employees, `ENTERPRISE` edition) and 8 ordinary
15-employee tenants (`PROFESSIONAL`) — never one giant tenant. Writes
`load/fixtures/tenants.json`, which every k6 scenario reads via `open()`.
Safe to re-run (purges and recreates its own `loadtest-*` tenants first).

## 2. Start the API (and, for the queue-depth panels, the worker)

```bash
cd apps/api
pnpm run start:prod   # or: pnpm run dev
# separately, if you also want worker/queue metrics:
pnpm run start:worker
```

## 3. Run a scenario

Each scenario is a standalone k6 script — run via the official Docker
image (no local k6 install needed):

```bash
docker run --rm --network host \
  -v "$(pwd)/load:/load" \
  grafana/k6:latest run /load/scenarios/login.js
```

Swap `login.js` for any of:

| Script | What it exercises |
| --- | --- |
| `login.js` | Auth hot path — many VUs across all 10 tenants (weighted by size). |
| `attendance-clockin.js` | The HIGH-VOLUME path — a real "everyone clocks in" burst, up to 200 concurrent employees. |
| `dashboard-read.js` | The analytics dashboard — precomputed-rollup reads only (1.5). |
| `employees-list.js` | A paginated/filtered list+search endpoint. |
| `payroll-run.js` | A full create → calculate → poll payroll run cycle (ENTERPRISE tenants only — low concurrency, payroll is inherently a rare/heavy operation). |
| `rate-limit-isolation.js` | Proves per-tenant rate-limit isolation UNDER LOAD (0.10) — a noisy tenant gets 429s, a quiet one never does. |
| `load-shedding.js` | Proves load shedding UNDER LOAD (0.10) — LOW-priority traffic is shed while CRITICAL (`/health/live`) stays fast. |
| `pool-backpressure.js` | Proves DB pool exhaustion UNDER LOAD returns clean 503s, never a hang (0.10). |

Override the target with `-e BASE_URL=... -e TENANT_BASE_DOMAIN=...` if not
running against `localhost:3001`/`yourhrms.local`.

## 4. Watch it in Grafana (optional)

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d prometheus grafana
# Grafana: http://localhost:3300 (admin/admin)
```

## Honest scope

This is real, measured local load testing — NOT a claim of having tested
this system at anything close to 20M users. See
`docs/conventions/observability-load.md` § The honest 20M extrapolation
for what was actually measured, on what hardware, and what scales
horizontally vs. what would need sharding at the true target ceiling.
