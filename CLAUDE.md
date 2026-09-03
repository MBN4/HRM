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

| File                                                                                           | Covers                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md)                                                     | Full append-only build history — every step, its files, bugs caught, and verification notes.                                                                                                                                                                                                                   |
| [`docs/conventions/tenancy-rls.md`](./docs/conventions/tenancy-rls.md)                         | Tenant data model, Row-Level Security, the two-DB-role design, `withTenantContext`. (0.2)                                                                                                                                                                                                                      |
| [`docs/conventions/tenant-resolution.md`](./docs/conventions/tenant-resolution.md)             | Request → tenant binding (subdomain/custom-domain/header), `TenantScopeInterceptor`, `AsyncLocalStorage` context, the platform (no-tenant) seam. (0.3)                                                                                                                                                         |
| [`docs/conventions/auth-rbac.md`](./docs/conventions/auth-rbac.md)                             | Login/JWT/refresh-rotation, DB-backed deny-by-default RBAC, branch scoping, the SSO seam. (0.4)                                                                                                                                                                                                                |
| [`docs/conventions/field-level-permissions.md`](./docs/conventions/field-level-permissions.md) | The reusable `@RequiresPermission()` DTO-field-gating pattern. (0.4)                                                                                                                                                                                                                                           |
| [`docs/conventions/country-packs.md`](./docs/conventions/country-packs.md)                     | Per-country legal/cultural config, the sandboxed tax/statutory rules engine, tenant overrides. (0.5)                                                                                                                                                                                                           |
| [`docs/conventions/licensing-feature-flags.md`](./docs/conventions/licensing-feature-flags.md) | Edition → feature flags, SaaS subscription vs. signed lifetime license, offline activation, platform admin routes. (0.6)                                                                                                                                                                                       |
| [`docs/conventions/workflow.md`](./docs/conventions/workflow.md)                               | The one generic approval engine — sequential/parallel/conditional steps, approver rules, delegation, escalation. (0.7)                                                                                                                                                                                         |
| [`docs/conventions/notifications-queues.md`](./docs/conventions/notifications-queues.md)       | Multi-channel notification delivery, the reusable BullMQ queue pattern, templates, recipient/locale resolution. (0.8)                                                                                                                                                                                          |
| [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)         | Append-only DB-immutable audit log (HTTP + domain-event capture) and tenant-extensible custom fields. (0.9)                                                                                                                                                                                                    |
| [`docs/conventions/i18n-timezone-rtl.md`](./docs/conventions/i18n-timezone-rtl.md)             | UTC-storage/local-render timestamp convention, RTL resolution, the two string-externalization catalogs. (0.9)                                                                                                                                                                                                  |
| [`docs/conventions/resilience.md`](./docs/conventions/resilience.md)                           | Per-tenant rate limiting, circuit breakers, load shedding, connection-pool protection, idempotency, health/graceful shutdown. (0.10)                                                                                                                                                                           |
| [`docs/conventions/tooling-eslint-config.md`](./docs/conventions/tooling-eslint-config.md)     | ESLint/pre-commit conventions for adding a new workspace (`root: true`, `parserOptions.project` overrides).                                                                                                                                                                                                    |
| [`docs/conventions/employee.md`](./docs/conventions/employee.md)                               | The core HR entity — encryption at rest, country-driven required fields, custom fields, org chart, bulk import, and feeding 0.7's workflow approver-rule seams. (1.1)                                                                                                                                          |
| [`docs/conventions/leave.md`](./docs/conventions/leave.md)                                     | Leave requests as a pure consumer of the workflow engine, country-driven entitlements/holidays/weekends, balance tracking, and scheduled/idempotent accrual. (1.2)                                                                                                                                             |
| [`docs/conventions/attendance.md`](./docs/conventions/attendance.md)                           | The first high-volume module: partition-ready clock records, timezone-correct (incl. midnight-crossing) day attribution, pack-driven weekend/overtime, the biometric device seam, and regularization via the workflow engine. (1.3)                                                                            |
| [`docs/conventions/frontend-ess-mss.md`](./docs/conventions/frontend-ess-mss.md)               | ESS/MSS on the tenant portal + mobile app: client auth/tenant resolution, the session-aware i18n/RTL integration, how the UI consumes workflow/leave/attendance, field-omission handling. (1.4)                                                                                                                |
| [`docs/conventions/analytics-dashboard.md`](./docs/conventions/analytics-dashboard.md)         | The KPI set, the precomputed-rollup scale strategy (incl. the nullable-dimension delete-recreate gotcha), the first real scheduled BullMQ job, and branch-scope/RBAC in analytics. (1.5)                                                                                                                       |
| [`docs/conventions/payroll.md`](./docs/conventions/payroll.md)                                 | THE pack-driven boundary statement, CALCULATE vs. DELEGATE, money/multi-currency, idempotency+resumability, run lifecycle + workflow approval, payslip + bank-export seams, and "how to add a new country". (2.1)                                                                                              |
| [`docs/conventions/performance.md`](./docs/conventions/performance.md)                         | Rating scales + cycle review-type/eligibility config as DATA (not enums), reviewer resolution via the real org chart, enrollment, the review-vs-assignment split, workflow-driven sign-off, reminders, and pre-aggregated calibration analytics. (2.2)                                                         |
| [`docs/conventions/recruitment-lifecycle.md`](./docs/conventions/recruitment-lifecycle.md)     | ATS pipeline (requisitions/postings/candidates/offers via workflow), the public careers API, the candidate→Employee onboarding bridge + required-field enforcement, the shared checklist mini-engine, and offboarding + access revocation + the Payroll FINAL_SETTLEMENT hand-off. (2.3)                       |
| [`docs/conventions/frontend-admin-console.md`](./docs/conventions/frontend-admin-console.md)   | The Payroll/Performance/Recruitment+Onboarding+Offboarding admin console on `apps/portal`: the shared `WorkflowStatusPanel` sign-off component, `apiFetchBlob` binary downloads, the one additive `GET /payroll/runs` endpoint, and known UI gaps. (2.4)                                                       |
| [`docs/conventions/operations-modules.md`](./docs/conventions/operations-modules.md)           | Expenses & Reimbursements, Asset Management, HR Helpdesk, Announcements & Policies — the expense→payroll reimbursement hand-off, asset↔offboarding wiring, helpdesk SLA escalation, policy e-acknowledgment. (3.1)                                                                                             |
| [`docs/conventions/lms.md`](./docs/conventions/lms.md)                                         | Learning & Development — courses/content/quizzes as config-as-data, completion gating, certification expiry+renewal, required-training compliance (rollup + bounded drill-down), two scheduled BullMQ jobs. (3.2)                                                                                              |
| [`docs/conventions/integrations.md`](./docs/conventions/integrations.md)                       | Outbound webhooks (signed, breaker-wrapped, queued), the versioned `/v1` public API + API keys + per-key rate limits + OpenAPI, the adapter-seam catalog (accounting/Slack/biometric/bank-export), and SSO (OIDC real, SAML seam) + ENTERPRISE gating. (3.3)                                                   |
| [`docs/conventions/vendor-console.md`](./docs/conventions/vendor-console.md)                   | The vendor super-admin console: platform identity/roles (separate from tenant `User`), mandatory MFA, the cross-tenant owner-`prisma` access pattern, tenant lifecycle (incl. `TENANT_STATUS` now enforced), Country Pack authoring/versioning, usage metrics, and impersonation + its audit guarantees. (4.1) |

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
- **2.3** — Recruitment (ATS) + Onboarding + Offboarding, the employee
  lifecycle (Phase 2's final step): job requisitions/offers approved via
  the workflow engine; a public, unauthenticated-but-tenant-scoped careers
  API; onboarding as the one bridge that creates a real 1.1 Employee from
  an accepted offer (enforcing country-pack required fields with zero new
  validation logic); a shared, tenant-configurable checklist mini-engine
  for both onboarding and offboarding; offboarding as the one bridge that
  hands a leaver's final pay to Payroll (a new `PayrollRun.runType` seam,
  additive to orchestration only, never the tax/statutory engine) and
  revokes their access via Auth's existing token-revocation primitive. See
  [`docs/conventions/recruitment-lifecycle.md`](./docs/conventions/recruitment-lifecycle.md).
- **2.4** — Admin/HR Console (renumbered from an earlier draft "3.1" —
  this UI-catch-up step actually belongs to Phase 2's own closing note, not
  Phase 3; "3.1" is reserved for Phase 3's real first slice, the four
  operations modules below): a pure consumption-
  layer UI on `apps/portal` surfacing Payroll/Performance/Recruitment+
  Onboarding+Offboarding, all of which shipped API-only in Phase 2. One
  additive backend endpoint (`GET /payroll/runs`); a shared
  `WorkflowStatusPanel` sign-off component reused across five entity
  types (the pre-existing `/approvals` inbox needed zero changes to pick
  up all five); `apiFetchBlob` for payslip/bank-export downloads. See
  [`docs/conventions/frontend-admin-console.md`](./docs/conventions/frontend-admin-console.md).
- **3.1** — Operations modules (Phase 3's first slice): Expenses &
  Reimbursements, Asset Management, HR Helpdesk/Ticketing, and
  Announcements & Policies — backend + portal UI together, four thin
  consumers of the workflow engine, storage, notifications, audit, and
  RBAC, none of which needed to change. An expense claim's approval is a
  real `WorkflowInstance` (`entityType: "EXPENSE_CLAIM"`, amount-thresholded
  via the sandboxed condition evaluator); an `APPROVED` claim is picked up
  by `PayrollRunProcessor` itself (an additive orchestration touch, the
  payroll engine untouched) and merged straight onto net pay, never
  computed by this module. The offboarding clearance checklist's
  placeholder "asset return" step (flagged in 2.3) is now wired to the
  real asset register. A general audit-redaction bug (`Decimal`/`Date`
  values mangled instead of using their own `toJSON()`) was caught and
  fixed in `packages/shared`, correcting every prior module's audited
  routes retroactively too. See
  [`docs/conventions/operations-modules.md`](./docs/conventions/operations-modules.md).
- **3.2** — Learning & Development (LMS): courses/content/quizzes authored
  as tenant DATA (never hardcoded scoring), one function
  (`recomputeCompletion`) deciding course completion, certifications with
  expiry + retake-based renewal, required-training compliance via a
  precomputed rollup for the dashboard plus a bounded live drill-down for
  "who exactly," and TWO independent scheduled BullMQ jobs (completion/
  compliance rollup, certification-expiry reminders — the latter
  idempotent via a DB `lastReminderBucket` column, no Redis idempotency
  key needed). See [`docs/conventions/lms.md`](./docs/conventions/lms.md).
- **3.3** — Integrations (Phase 3's final slice, backend-only): outbound
  webhooks (HMAC-signed, BullMQ-delivered, one circuit breaker per
  subscription, dead-lettered) over the domain events already emitted
  system-wide; a versioned `/v1` public API authenticated by a SECOND,
  parallel path — a scoped, argon2id-hashed `ApiKey` header, checked in
  `TenantScopeInterceptor` alongside the existing JWT path, still fully
  RLS-enforced; four adapter seams (accounting stub, a REAL Slack
  `NotificationProvider`, the 1.3 biometric seam formalized with a device
  registry, the 2.1 bank-export seam formalized into a pluggable
  registry); and SSO finished as a SEPARATE flow from `AUTH_PROVIDER`
  (real OIDC, a documented SAML gap), ENTERPRISE-gated. **PHASE 3
  COMPLETE as of this step.** See
  [`docs/conventions/integrations.md`](./docs/conventions/integrations.md).

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
resilience chassis. Phase 2 (Payroll, Performance, Recruitment/Onboarding/
Offboarding) is now complete — see below.

- [x] **2.1** Payroll module (pack-driven CALCULATE/DELEGATE engine,
      multi-currency, idempotent/resumable runs, workflow approval,
      payslips, bank export)
- [x] **2.2** Performance management module (goals/OKRs, tenant-configurable
      rating scales + cycle review-type/eligibility config as data,
      org-chart-resolved reviewers, workflow-driven sign-off, reminders,
      pre-aggregated calibration analytics)
- [x] **2.3** Recruitment (ATS) + Onboarding + Offboarding — the employee
      lifecycle (workflow-approved requisitions/offers, a public careers
      API, the candidate→Employee onboarding bridge with country-pack
      required-field enforcement, a shared checklist mini-engine, and
      offboarding's Payroll final-settlement + access-revocation hand-off)

**PHASE 2 COMPLETE.** Payroll (2.1) + Performance (2.2) + Recruitment/
Onboarding/Offboarding (2.3) — the full compensation and employee-lifecycle
layer, on top of Phase 0's chassis and Phase 1's Core HR/Leave/Attendance/
ESS/Analytics foundation.

- [x] **2.4** Admin/HR Console — Payroll/Performance/Recruitment+Onboarding+
      Offboarding UI on `apps/portal` (one additive `GET /payroll/runs`
      endpoint, a shared `WorkflowStatusPanel` sign-off component, binary
      payslip/bank-export downloads); closes the Phase 2 UI gap 2.3's own
      closing note named as a Phase 3 candidate. (Renumbered from an
      earlier draft "3.1" so Phase 3's own numbering below starts clean.)

**PHASE 2, including its UI catch-up pass, now fully complete** — Payroll
(2.1) + Performance (2.2) + Recruitment/Onboarding/Offboarding (2.3) +
Admin/HR Console (2.4).

- [x] **3.1** Operations modules — Expenses & Reimbursements, Asset
      Management, HR Helpdesk/Ticketing, Announcements & Policies —
      backend + portal UI together, thin consumers of the workflow engine,
      storage, notifications, audit, and RBAC. Expense claims hand off to
      Payroll as a reimbursement input; asset return closes the offboarding
      clearance checklist's real placeholder step; the ESS announcements
      seam left in 1.4 is now wired to real data. See
      [`docs/conventions/operations-modules.md`](./docs/conventions/operations-modules.md).
- [x] **3.2** Learning & Development (LMS) — courses/content/modules,
      self-enroll + admin/manager assignment, content progress, a
      config-as-data quiz gating completion, certifications with expiry +
      retake-based renewal, required-training compliance (a precomputed
      rollup for the dashboard, a bounded live drill-down for who's
      missing/expiring), and two independent scheduled BullMQ jobs
      (completion/compliance rollup, certification-expiry reminders). See
      [`docs/conventions/lms.md`](./docs/conventions/lms.md).

- [x] **3.3** Integrations — outbound webhooks (signed/breaker-wrapped/
      queued over the domain events already emitted), the versioned `/v1`
      public API + scoped API keys (a second, parallel auth path,
      RLS-enforced) + per-key rate limits + OpenAPI, four adapter seams
      (accounting, a real Slack `NotificationProvider`, the formalized 1.3
      biometric seam, the formalized 2.1 pluggable bank-export registry),
      and SSO finished (real OIDC, a documented SAML gap, ENTERPRISE-gated).
      See [`docs/conventions/integrations.md`](./docs/conventions/integrations.md).

**PHASE 3 COMPLETE.** Operations modules (3.1) + LMS (3.2) + Integrations
(3.3) — the full "extend without forking" layer: every tenant/vendor
integration point (webhooks, a public API, pluggable adapters, SSO) is now
additive configuration or a new DI binding, never a fork of this codebase.

- **4.1** — Vendor super-admin console (Phase 4's first slice): closed a
  real gap left open since 0.3/0.6 — `@PlatformRoute()` previously carried
  NO authenticated identity, only the `PLATFORM_MODE_ENABLED` flag. Now
  every platform route requires a fully authenticated, MANDATORY-MFA
  `PlatformAdmin` (a structurally separate identity space from tenant
  `User`, two code-level least-privilege roles) via a platform-only JWT
  secret (never confusable with a tenant token). Tenant lifecycle
  (create/suspend/resume/delete, `TENANT_STATUS` now actually enforced —
  a suspended tenant is genuinely blocked, including its own login route);
  Country Pack authoring/versioning/activation reusing the existing 0.5
  schema/engine unmodified; usage metrics from cheap existing reads only;
  impersonation that's permission-gated, server-side time-boxed (the
  session ROW is re-checked live on every request, not just the token's
  `exp`), and LOUDLY audited into both the platform's own trail and the
  target tenant's own `audit_log` (every action taken while impersonating
  tagged with the real admin's id); cross-tenant audit read that is
  itself audited. `apps/admin` built out from a near-empty scaffold with
  its own distinct visual identity. Reuses licensing/pack engines and the
  audit sink unmodified throughout — never rebuilt. See
  [`docs/conventions/vendor-console.md`](./docs/conventions/vendor-console.md).

- [x] **4.1** Vendor super-admin console — platform admin identity/MFA
      (separate from tenant `User`), least-privilege platform roles,
      tenant lifecycle (`TENANT_STATUS` now enforced), Country Pack
      authoring/versioning, usage metrics, cross-tenant audit read, and
      permission-gated/time-boxed/loudly-audited impersonation. `apps/admin`
      built out from its prior placeholder. See
      [`docs/conventions/vendor-console.md`](./docs/conventions/vendor-console.md).
- [ ] **Phase 4 remaining** — **4.2** real SaaS billing (0.6's
      `Subscription` model is a stub for this — a real Stripe integration;
      4.1's usage metrics are its named first consumer) and **4.3**
      white-labeling (per-tenant branding/theming on top of the
      multi-tenant core, in the spirit of CLAUDE.md § 2's "customizable
      without forking").
- [ ] **Phase 5** — _scope not yet defined_ (5.2 is already known to
      partition `audit_log` — see
      [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)
      — and, per 0.2's original note, `attendance_records`, now built
      partition-ready in 1.3 — see
      [`docs/conventions/attendance.md`](./docs/conventions/attendance.md);
      5.1 is already known to cover full PgBouncer/read replicas, flagged in
      resilience.md; 5.3 is horizontal scaling, which the resilience
      chassis's stateless-by-design posture already prepares for)
- [ ] **Phase 6** — _scope not yet defined_
