# HRM — Project Memory

This file is the persistent memory for this project — kept deliberately
**lean**: it's the map every session reads first, not the detail itself.
Read it before starting new work.

**How to use these docs.** Always read this file first. Then, before
touching a subsystem, read its specific file under
[`docs/conventions/`](./docs/conventions/) (see the index below) — that's
where the actual design decisions, tradeoffs, and "why" live. For what
landed and when, see [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md).
**Convention going forward: when a step lands, append its detail to
`docs/BUILD_LOG.md` and add/update the relevant `docs/conventions/*.md`
file(s) — keep this file's summary + index current, but do NOT dump
detail back in here.** This file only grows for: a new non-negotiable, a
new workspace in the stack table, a new docs index row, a new one-line
build-log summary entry, and Not-yet-built checklist updates.

## 1. Overview

HRM is a **global, multi-tenant HR SaaS**, sold under two delivery models:

- **Rented SaaS** — vendor-hosted, multi-tenant, subscription-billed.
- **Lifetime on-prem license** — a customer runs the same codebase on their
  own infrastructure under a perpetual license, single-tenant in practice but
  built from the same multi-tenant core (no forked codebase).

Both delivery models ship from **one codebase**. Behavioral differences
between SaaS and on-prem (billing, licensing checks, update cadence) are
handled by configuration and feature flags, never by branching the code.

## 2. Non-negotiables

- **Scalable** — designed to scale to 20M users. Must degrade gracefully
  under load (backpressure, queueing, circuit breaking) rather than fail
  hard.
- **Secure** — defense-in-depth is mandatory, not optional:
  - Row-Level Security (RLS) for tenant data isolation at the database layer
  - RBAC for authorization
  - Encryption (in transit and at rest)
  - Audit logging of sensitive actions
  - No single layer is trusted alone — assume any one control can fail
- **Customizable without forking** — every country's/tenant's differences
  (legal, payroll, holidays, statutory fields, workflows) are expressed via:
  - **Country Packs** — pluggable, versioned configuration per country
  - **Tenant overrides** — tenant-level configuration layered on top
  - **Feature flags** — for gradual rollout and tenant-specific toggles
  - Forking the codebase per customer/country is explicitly disallowed.
- **Multi-tenant** — a single deployment serves many tenants; tenant
  isolation is a first-class architectural concern, not an afterthought.

## 3. Stack & workspace map

**Stack**: Turborepo + pnpm workspaces · NestJS + TypeScript (API) · Next.js
14 App Router (web apps) · Prisma + PostgreSQL 16 · Redis · BullMQ · MinIO
(S3-compatible object storage, local dev).

| Path              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `apps/api`        | NestJS backend — all business logic, REST API                 |
| `apps/admin`      | Vendor super-admin console (Next.js App Router)               |
| `apps/portal`     | Tenant org portal (Next.js App Router)                        |
| `apps/mobile`     | Employee self-service mobile app (React Native / Expo)        |
| `packages/db`     | Prisma schema + generated client (`@hrm/db`)                  |
| `packages/shared` | Shared types, DTOs, zod validators, constants (`@hrm/shared`) |
| `packages/config` | Shared ESLint / TypeScript / Prettier config (`@hrm/config`)  |

Infra for local dev: `docker-compose.yml` runs Postgres 16, Redis, and MinIO.
Every app/package that needs environment variables documents them in its own
`.env.example`.

## 4. Docs index

| File                                                                                           | Covers                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md)                                                     | Full append-only build history — every step, its files, bugs caught, and verification notes.                                                                                                                                                           |
| [`docs/conventions/tenancy-rls.md`](./docs/conventions/tenancy-rls.md)                         | Tenant data model, Row-Level Security, the two-DB-role design, `withTenantContext`. (0.2)                                                                                                                                                              |
| [`docs/conventions/tenant-resolution.md`](./docs/conventions/tenant-resolution.md)             | Request → tenant binding (subdomain/custom-domain/header), `TenantScopeInterceptor`, `AsyncLocalStorage` context, the platform (no-tenant) seam. (0.3)                                                                                                 |
| [`docs/conventions/auth-rbac.md`](./docs/conventions/auth-rbac.md)                             | Login/JWT/refresh-rotation, DB-backed deny-by-default RBAC, branch scoping, the SSO seam. (0.4)                                                                                                                                                        |
| [`docs/conventions/field-level-permissions.md`](./docs/conventions/field-level-permissions.md) | The reusable `@RequiresPermission()` DTO-field-gating pattern. (0.4)                                                                                                                                                                                   |
| [`docs/conventions/country-packs.md`](./docs/conventions/country-packs.md)                     | Per-country legal/cultural config, the sandboxed tax/statutory rules engine, tenant overrides. (0.5)                                                                                                                                                   |
| [`docs/conventions/licensing-feature-flags.md`](./docs/conventions/licensing-feature-flags.md) | Edition → feature flags, SaaS subscription vs. signed lifetime license, offline activation, platform admin routes. (0.6)                                                                                                                               |
| [`docs/conventions/workflow.md`](./docs/conventions/workflow.md)                               | The one generic approval engine — sequential/parallel/conditional steps, approver rules, delegation, escalation. (0.7)                                                                                                                                 |
| [`docs/conventions/notifications-queues.md`](./docs/conventions/notifications-queues.md)       | Multi-channel notification delivery, the reusable BullMQ queue pattern, templates, recipient/locale resolution. (0.8)                                                                                                                                  |
| [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)         | Append-only DB-immutable audit log (HTTP + domain-event capture) and tenant-extensible custom fields. (0.9)                                                                                                                                            |
| [`docs/conventions/i18n-timezone-rtl.md`](./docs/conventions/i18n-timezone-rtl.md)             | UTC-storage/local-render timestamp convention, RTL resolution, the two string-externalization catalogs. (0.9)                                                                                                                                          |
| [`docs/conventions/resilience.md`](./docs/conventions/resilience.md)                           | Per-tenant rate limiting, circuit breakers, load shedding, connection-pool protection, idempotency, health/graceful shutdown. (0.10)                                                                                                                   |
| [`docs/conventions/tooling-eslint-config.md`](./docs/conventions/tooling-eslint-config.md)     | ESLint/pre-commit conventions for adding a new workspace (`root: true`, `parserOptions.project` overrides).                                                                                                                                            |
| [`docs/conventions/employee.md`](./docs/conventions/employee.md)                               | The core HR entity — encryption at rest, country-driven required fields, custom fields, org chart, bulk import, and feeding 0.7's workflow approver-rule seams. (1.1)                                                                                  |
| [`docs/conventions/leave.md`](./docs/conventions/leave.md)                                     | Leave requests as a pure consumer of the workflow engine, country-driven entitlements/holidays/weekends, balance tracking, and scheduled/idempotent accrual. (1.2)                                                                                     |
| [`docs/conventions/attendance.md`](./docs/conventions/attendance.md)                           | The first high-volume module: partition-ready clock records, timezone-correct (incl. midnight-crossing) day attribution, pack-driven weekend/overtime, the biometric device seam, and regularization via the workflow engine. (1.3)                    |
| [`docs/conventions/frontend-ess-mss.md`](./docs/conventions/frontend-ess-mss.md)               | ESS/MSS on the tenant portal + mobile app: client auth/tenant resolution, the session-aware i18n/RTL integration, how the UI consumes workflow/leave/attendance, field-omission handling. (1.4)                                                        |
| [`docs/conventions/analytics-dashboard.md`](./docs/conventions/analytics-dashboard.md)         | The KPI set, the precomputed-rollup scale strategy (incl. the nullable-dimension delete-recreate gotcha), the first real scheduled BullMQ job, and branch-scope/RBAC in analytics. (1.5)                                                               |
| [`docs/conventions/payroll.md`](./docs/conventions/payroll.md)                                 | THE pack-driven boundary statement, CALCULATE vs. DELEGATE, money/multi-currency, idempotency+resumability, run lifecycle + workflow approval, payslip + bank-export seams, and "how to add a new country". (2.1)                                      |
| [`docs/conventions/performance.md`](./docs/conventions/performance.md)                         | Rating scales + cycle review-type/eligibility config as DATA (not enums), reviewer resolution via the real org chart, enrollment, the review-vs-assignment split, workflow-driven sign-off, reminders, and pre-aggregated calibration analytics. (2.2) |

## 5. Build log summary

Full detail, file lists, and verification notes for every entry below live
in [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md) — this is a one-line pointer
per step, kept here for a fast overview.

- **0.1** — Monorepo scaffold (Turborepo/pnpm, `apps/{api,admin,portal}` +
  `packages/{db,shared,config}`, Docker Compose, Husky/commitlint). Plus two
  follow-up pre-commit/ESLint fixes — see
  [`docs/conventions/tooling-eslint-config.md`](./docs/conventions/tooling-eslint-config.md).
- **0.2** — Tenancy model / Row-Level Security. See
  [`docs/conventions/tenancy-rls.md`](./docs/conventions/tenancy-rls.md).
- **0.3** — Tenant resolution (request → tenant binding). See
  [`docs/conventions/tenant-resolution.md`](./docs/conventions/tenant-resolution.md).
- **0.4** — Auth / RBAC + field-level permissions. See
  [`docs/conventions/auth-rbac.md`](./docs/conventions/auth-rbac.md) and
  [`docs/conventions/field-level-permissions.md`](./docs/conventions/field-level-permissions.md).
- **0.5** — Country packs (rules engine, two-layer overrides). See
  [`docs/conventions/country-packs.md`](./docs/conventions/country-packs.md).
- **0.6** — Licensing (SaaS vs. lifetime on-prem) + feature flags. See
  [`docs/conventions/licensing-feature-flags.md`](./docs/conventions/licensing-feature-flags.md).
- **0.7** — Workflow / approval engine. See
  [`docs/conventions/workflow.md`](./docs/conventions/workflow.md).
- **0.8** — Notifications hub + reusable BullMQ queue infrastructure. See
  [`docs/conventions/notifications-queues.md`](./docs/conventions/notifications-queues.md).
- **0.9** — Audit logging, custom fields, i18n/timezone/RTL. See
  [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)
  and [`docs/conventions/i18n-timezone-rtl.md`](./docs/conventions/i18n-timezone-rtl.md).
- **0.10** — Resilience chassis (rate limits, circuit breakers, load
  shedding, pool protection, idempotency, health/shutdown). **PHASE 0
  (foundational chassis) COMPLETE as of this step.** See
  [`docs/conventions/resilience.md`](./docs/conventions/resilience.md).
- **Docs reorganization (2026-08-27)** — no code/schema/test changes; split
  this file's Conventions/Build-log sections out into `docs/BUILD_LOG.md`
  and `docs/conventions/*.md` to keep this entry point lean. See the
  matching [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md) entry.
- **1.1** — Employee module (Phase 1's first step): encryption at rest,
  country-driven required fields, custom fields, org chart, bulk CSV
  import, document storage (S3/MinIO), and feeding 0.7's workflow
  approver-rule seams with real org-chart data. See
  [`docs/conventions/employee.md`](./docs/conventions/employee.md).
- **1.2** — Leave module: a leave request is just a `WorkflowInstance`
  (no bespoke approval logic), country-driven entitlements/holidays/
  weekends via Country Packs, balance tracking, and idempotent scheduled
  accrual via the 0.8 BullMQ pattern. See
  [`docs/conventions/leave.md`](./docs/conventions/leave.md).
- **1.3** — Attendance & time-tracking module: the first HIGH-VOLUME
  module, built partition-ready (`AttendanceRecord`'s composite PK, like
  `audit_log`) from day one — clock-in/out with optional geo-fencing/selfie
  capture, timezone-correct (incl. midnight-crossing) working-day
  attribution via each branch's own timezone, pack-driven weekend/overtime
  rules, the biometric-device seam, and regularization as just another
  `WorkflowInstance`. See
  [`docs/conventions/attendance.md`](./docs/conventions/attendance.md).
- **1.4** — ESS/MSS self-service UI on the tenant portal (`apps/portal`,
  Next.js) and a new mobile app (`apps/mobile`, React Native/Expo, ESS +
  clock-in + push only) — a pure consumption layer over 0.4–0.8/1.1–1.3,
  plus two small additive backend endpoints (`GET /employees/me`,
  `POST /auth/push-token`). Session-aware i18n/RTL (the first real use of
  the resolved Country Pack's `locale.rtl`), field-omission-aware UI,
  RBAC-gated rendering, and a real-browser Playwright suite for the
  portal. See
  [`docs/conventions/frontend-ess-mss.md`](./docs/conventions/frontend-ess-mss.md).
- **1.5** — Analytics dashboard (Phase 1's final step): tenant/branch-scoped
  KPIs (headcount, joiners/leavers/attrition, attendance rate, leave
  utilization) on the tenant portal, computed via the codebase's first real
  SCHEDULED BullMQ job into four precomputed rollup tables — a dashboard
  load is always a cheap indexed read of those, never a live aggregate
  over `employees`/`attendance_records`/`leave_requests`/`leave_balances`.
  **PHASE 1 COMPLETE as of this step** — see
  [`docs/conventions/analytics-dashboard.md`](./docs/conventions/analytics-dashboard.md).
- **2.1** — Payroll module (Phase 2's first step, THE HIGHEST-RISK MODULE):
  an engine that computes strictly what the resolved Country Pack declares
  — the SAME code produces a correct US run (4-layer tax) and a correct
  Qatar run (no income tax, tiered end-of-service gratuity) from the two
  existing reference packs. CALCULATE (in-house engine) vs. DELEGATE
  (external-provider adapter seam) per pack; `Decimal`-only money with a
  snapshotted multi-currency rollup; two-layer idempotent, resumable
  BullMQ runs; approval via the 0.7 workflow engine (no bespoke logic);
  payslip PDFs in the pack's own language; a bank-export adapter seam. See
  [`docs/conventions/payroll.md`](./docs/conventions/payroll.md).
- **2.2** — Performance management module: a thin consumer of the workflow
  engine (routing/sign-off), the 1.1 org chart (reviewer resolution — SELF/
  MANAGER/UPWARD auto-resolved, PEER always explicit), and the notification
  hub (reminders). Goals/OKRs cascading company → team → individual; tenant-
  configurable rating scales and cycle review-type/eligibility config as
  DATA, never a hardcoded enum ("360" = a cycle enabling all four review
  types, not a fifth type); calibration/distribution analytics via the
  same precomputed-rollup discipline 1.5 established. See
  [`docs/conventions/performance.md`](./docs/conventions/performance.md).

## 6. Not yet built

- [x] **0.2** Tenancy model / Row-Level Security (RLS)
- [x] **0.3** Tenant resolution (request → tenant binding)
- [x] **0.4** Auth / RBAC
- [x] **0.5** Country packs
- [x] **0.6** Licensing (SaaS vs. lifetime on-prem enforcement)
- [x] **0.7** Workflow engine
- [x] **0.8** Notifications
- [x] **0.9** Audit logging, custom fields, i18n
- [x] **0.10** Resilience (graceful degradation, backpressure, circuit breaking)

**PHASE 0 (foundational chassis) COMPLETE.** Phase 1 (Employee, Leave,
Attendance, ESS/MSS, dashboard) is the first phase to build real HR
functionality — and builds directly on top of everything above: tenancy/RLS,
tenant resolution, auth/RBAC, country packs, licensing, the workflow engine,
notifications, audit/custom-fields/i18n, and the resilience chassis all
apply automatically to any new module/route with no additional wiring.

- [x] **1.1** Employee module (core HR entity)
- [x] **1.2** Leave module
- [x] **1.3** Attendance & time-tracking module
- [x] **1.4** ESS/MSS self-service UI (tenant portal + mobile app)
- [x] **1.5** Analytics dashboard (tenant/branch-scoped KPIs, precomputed
      rollups, the first real scheduled BullMQ job)

**PHASE 1 COMPLETE.** The product is now a sellable MVP — Core HR (1.1) +
Leave (1.2) + Attendance (1.3) + ESS/MSS (1.4) + Analytics dashboard (1.5),
all built on top of Phase 0's tenancy/RLS, auth/RBAC, country packs,
licensing, workflow engine, notifications, audit/custom-fields/i18n, and
resilience chassis. Phase 2 (Payroll, Performance, Recruitment) builds next.

- [x] **2.1** Payroll module (pack-driven CALCULATE/DELEGATE engine,
      multi-currency, idempotent/resumable runs, workflow approval,
      payslips, bank export)
- [x] **2.2** Performance management module (goals/OKRs, tenant-configurable
      rating scales + cycle review-type/eligibility config as data,
      org-chart-resolved reviewers, workflow-driven sign-off, reminders,
      pre-aggregated calibration analytics)
- [ ] **Phase 2 (remaining)** — Recruitment — _scope not yet defined_
- [ ] **Phase 3** — _scope not yet defined_
- [ ] **Phase 4** — _scope not yet defined_
- [ ] **Phase 5** — _scope not yet defined_ (5.2 is already known to
      partition `audit_log` — see
      [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)
      — and, per 0.2's original note, `attendance_records`, now built
      partition-ready in 1.3 — see
      [`docs/conventions/attendance.md`](./docs/conventions/attendance.md))
- [ ] **Phase 6** — _scope not yet defined_
