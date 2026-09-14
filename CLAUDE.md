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

| File                                                                                           | Covers                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md)                                                     | Full append-only build history — every step, its files, bugs caught, and verification notes.                                                                                                                                                                                                                                                                                       |
| [`docs/conventions/tenancy-rls.md`](./docs/conventions/tenancy-rls.md)                         | Tenant data model, Row-Level Security, the two-DB-role design, `withTenantContext`. (0.2)                                                                                                                                                                                                                                                                                          |
| [`docs/conventions/tenant-resolution.md`](./docs/conventions/tenant-resolution.md)             | Request → tenant binding (subdomain/custom-domain/header), `TenantScopeInterceptor`, `AsyncLocalStorage` context, the platform (no-tenant) seam. (0.3)                                                                                                                                                                                                                             |
| [`docs/conventions/auth-rbac.md`](./docs/conventions/auth-rbac.md)                             | Login/JWT/refresh-rotation, DB-backed deny-by-default RBAC, branch scoping, the SSO seam. (0.4)                                                                                                                                                                                                                                                                                    |
| [`docs/conventions/field-level-permissions.md`](./docs/conventions/field-level-permissions.md) | The reusable `@RequiresPermission()` DTO-field-gating pattern. (0.4)                                                                                                                                                                                                                                                                                                               |
| [`docs/conventions/country-packs.md`](./docs/conventions/country-packs.md)                     | Per-country legal/cultural config, the sandboxed tax/statutory rules engine, tenant overrides. (0.5)                                                                                                                                                                                                                                                                               |
| [`docs/conventions/licensing-feature-flags.md`](./docs/conventions/licensing-feature-flags.md) | Edition → feature flags, SaaS subscription vs. signed lifetime license, offline activation, platform admin routes. (0.6)                                                                                                                                                                                                                                                           |
| [`docs/conventions/workflow.md`](./docs/conventions/workflow.md)                               | The one generic approval engine — sequential/parallel/conditional steps, approver rules, delegation, escalation. (0.7)                                                                                                                                                                                                                                                             |
| [`docs/conventions/notifications-queues.md`](./docs/conventions/notifications-queues.md)       | Multi-channel notification delivery, the reusable BullMQ queue pattern, templates, recipient/locale resolution. (0.8)                                                                                                                                                                                                                                                              |
| [`docs/conventions/audit-custom-fields.md`](./docs/conventions/audit-custom-fields.md)         | Append-only DB-immutable audit log (HTTP + domain-event capture) and tenant-extensible custom fields. (0.9)                                                                                                                                                                                                                                                                        |
| [`docs/conventions/i18n-timezone-rtl.md`](./docs/conventions/i18n-timezone-rtl.md)             | UTC-storage/local-render timestamp convention, RTL resolution, the two string-externalization catalogs. (0.9)                                                                                                                                                                                                                                                                      |
| [`docs/conventions/resilience.md`](./docs/conventions/resilience.md)                           | Per-tenant rate limiting, circuit breakers, load shedding, connection-pool protection, idempotency, health/graceful shutdown. (0.10)                                                                                                                                                                                                                                               |
| [`docs/conventions/tooling-eslint-config.md`](./docs/conventions/tooling-eslint-config.md)     | ESLint/pre-commit conventions for adding a new workspace (`root: true`, `parserOptions.project` overrides).                                                                                                                                                                                                                                                                        |
| [`docs/conventions/employee.md`](./docs/conventions/employee.md)                               | The core HR entity — encryption at rest, country-driven required fields, custom fields, org chart, bulk import, and feeding 0.7's workflow approver-rule seams. (1.1)                                                                                                                                                                                                              |
| [`docs/conventions/leave.md`](./docs/conventions/leave.md)                                     | Leave requests as a pure consumer of the workflow engine, country-driven entitlements/holidays/weekends, balance tracking, and scheduled/idempotent accrual. (1.2)                                                                                                                                                                                                                 |
| [`docs/conventions/attendance.md`](./docs/conventions/attendance.md)                           | The first high-volume module: partition-ready clock records, timezone-correct (incl. midnight-crossing) day attribution, pack-driven weekend/overtime, the biometric device seam, and regularization via the workflow engine. (1.3)                                                                                                                                                |
| [`docs/conventions/frontend-ess-mss.md`](./docs/conventions/frontend-ess-mss.md)               | ESS/MSS on the tenant portal + mobile app: client auth/tenant resolution, the session-aware i18n/RTL integration, how the UI consumes workflow/leave/attendance, field-omission handling. (1.4)                                                                                                                                                                                    |
| [`docs/conventions/analytics-dashboard.md`](./docs/conventions/analytics-dashboard.md)         | The KPI set, the precomputed-rollup scale strategy (incl. the nullable-dimension delete-recreate gotcha), the first real scheduled BullMQ job, and branch-scope/RBAC in analytics. (1.5)                                                                                                                                                                                           |
| [`docs/conventions/payroll.md`](./docs/conventions/payroll.md)                                 | THE pack-driven boundary statement, CALCULATE vs. DELEGATE, money/multi-currency, idempotency+resumability, run lifecycle + workflow approval, payslip + bank-export seams, and "how to add a new country". (2.1)                                                                                                                                                                  |
| [`docs/conventions/performance.md`](./docs/conventions/performance.md)                         | Rating scales + cycle review-type/eligibility config as DATA (not enums), reviewer resolution via the real org chart, enrollment, the review-vs-assignment split, workflow-driven sign-off, reminders, and pre-aggregated calibration analytics. (2.2)                                                                                                                             |
| [`docs/conventions/recruitment-lifecycle.md`](./docs/conventions/recruitment-lifecycle.md)     | ATS pipeline (requisitions/postings/candidates/offers via workflow), the public careers API, the candidate→Employee onboarding bridge + required-field enforcement, the shared checklist mini-engine, and offboarding + access revocation + the Payroll FINAL_SETTLEMENT hand-off. (2.3)                                                                                           |
| [`docs/conventions/frontend-admin-console.md`](./docs/conventions/frontend-admin-console.md)   | The Payroll/Performance/Recruitment+Onboarding+Offboarding admin console on `apps/portal`: the shared `WorkflowStatusPanel` sign-off component, `apiFetchBlob` binary downloads, the one additive `GET /payroll/runs` endpoint, and known UI gaps. (2.4)                                                                                                                           |
| [`docs/conventions/operations-modules.md`](./docs/conventions/operations-modules.md)           | Expenses & Reimbursements, Asset Management, HR Helpdesk, Announcements & Policies — the expense→payroll reimbursement hand-off, asset↔offboarding wiring, helpdesk SLA escalation, policy e-acknowledgment. (3.1)                                                                                                                                                                 |
| [`docs/conventions/lms.md`](./docs/conventions/lms.md)                                         | Learning & Development — courses/content/quizzes as config-as-data, completion gating, certification expiry+renewal, required-training compliance (rollup + bounded drill-down), two scheduled BullMQ jobs. (3.2)                                                                                                                                                                  |
| [`docs/conventions/integrations.md`](./docs/conventions/integrations.md)                       | Outbound webhooks (signed, breaker-wrapped, queued), the versioned `/v1` public API + API keys + per-key rate limits + OpenAPI, the adapter-seam catalog (accounting/Slack/biometric/bank-export), and SSO (OIDC real, SAML seam) + ENTERPRISE gating. (3.3)                                                                                                                       |
| [`docs/conventions/vendor-console.md`](./docs/conventions/vendor-console.md)                   | The vendor super-admin console: platform identity/roles (separate from tenant `User`), mandatory MFA, the cross-tenant owner-`prisma` access pattern, tenant lifecycle (incl. `TENANT_STATUS` now enforced), Country Pack authoring/versioning, usage metrics, and impersonation + its audit guarantees. (4.1)                                                                     |
| [`docs/conventions/billing.md`](./docs/conventions/billing.md)                                 | SaaS-only billing via Stripe: real Subscription-state production (replacing the 0.6 stub), seat metering, the Stripe adapter seam (real vs. mock), signed/idempotent inbound webhooks, proration preview vs. the authoritative charge, AMC invoicing, and non-payment → suspension. (4.2)                                                                                          |
| [`docs/conventions/white-label.md`](./docs/conventions/white-label.md)                         | Per-tenant branding model + hot-path caching, theme tokens across portal/mobile/email, the branded-custom-domain + TLS-provisioning seam extending 0.3's resolution, the gated full-rebrand capability (live-re-checked), and vendor oversight + dual audit. (4.3)                                                                                                                 |
| [`docs/conventions/data-migration.md`](./docs/conventions/data-migration.md)                   | Data migration & onboarding toolkit: dry-run-via-rollback safety model, importers routed through the real Employee/Leave services, natural-key idempotency, manager-by-code linking, column-mapping templates, uploaded-file purge, tenant self-serve vs. platform-on-behalf-of. (3.5.1)                                                                                           |
| [`docs/conventions/benefits.md`](./docs/conventions/benefits.md)                               | Benefits administration: plan config mirroring `PayrollComponentDefinition`, statutory schemes needing zero payroll-engine change, enrollment + optional workflow approval, the benefits→payroll input hand-off, cost reporting. (3.5.2)                                                                                                                                           |
| [`docs/conventions/e-signatures.md`](./docs/conventions/e-signatures.md)                       | E-signatures: the tamper-evident evidentiary trail (document hashing, DB-immutable events, a certificate), external token-scoped signing links, sequential/parallel signer sequencing, the Offer/Policy integrations, the compliance boundary, and the future e-sign-provider seam. (3.5.3)                                                                                        |
| [`docs/conventions/pakistan-pack.md`](./docs/conventions/pakistan-pack.md)                     | A real, production-shaped Pakistan `CountryPack` (PKR, Sat-Sun weekend, RTL Urdu, a progressive income tax layer, wage-ceiling-based EOBI + Provident Fund, CNIC/NTN required), replacing the ad-hoc 3.5.2 test pack — every legally-sensitive figure an explicit, documented VERIFY-placeholder. (3.5.5)                                                                          |
| [`docs/conventions/statutory-reporting.md`](./docs/conventions/statutory-reporting.md)         | A country-extensible framework generating periodic government filing forms/exports FROM already-finalized payroll data (never recomputing), a report catalog + pluggable generator registry, Pakistan's four concrete reports (income tax withholding, EOBI, Provident Fund, annual statement), and the "verify current form specifics before filing" compliance boundary. (3.5.4) |
| [`docs/conventions/scaling-data-layer.md`](./docs/conventions/scaling-data-layer.md)           | Data-layer scale hardening: PgBouncer + the transaction-pooling/RLS safety proof, a real streaming read replica (RLS-identical + read-after-write), and tenant-scoped Redis caching (country packs, org structure, permissions) with immediate invalidation — plus the entitlement-caching attempt that was empirically reverted. (5.1)                                            |
| [`docs/conventions/partitioning-archival.md`](./docs/conventions/partitioning-archival.md)     | Native `PARTITION BY RANGE` for `attendance_records`/`audit_log`/`platform_audit_log` (additive conversion, RLS+immutability proven identical on partitions, partition pruning proven), the automated ahead-of-time partition-creation job, and the archival/retention mechanism + its Phase 6.1 GDPR seam. (5.2)                                                                  |
| [`docs/conventions/deployment-scaling.md`](./docs/conventions/deployment-scaling.md)           | The statelessness audit + its multi-instance proof, the `worker.ts`/`PROCESS_ROLE` API-worker split (proven against real BullMQ), Docker images, `deploy/k8s/` manifests (HPA/KEDA, probes, graceful rollout, migration-job safety), and the regional-deployment seam. (5.3)                                                                                                       |

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

- **4.2** — SaaS billing via Stripe (Phase 4's second slice, SaaS-mode
  ONLY — lifetime/on-prem tenants are completely unaffected, still
  license-file based): closes the gap 0.6 flagged at the time —
  `Subscription` rows drove SaaS entitlement since 0.6, but nothing ever
  produced a real one outside a seed/test fixture. `StripeWebhookService`/
  `BillingService` are now the sole real producers, through a
  Symbol-token `STRIPE_CLIENT` seam (`RealStripeClient`, the actual
  `stripe` SDK; `MockStripeClient`, an in-memory fake bound whenever
  `STRIPE_SECRET_KEY` is unset — what lets the full suite run with no
  live Stripe account). Seat metering reuses 0.6's OWN seat-count
  (`SeatCapService.countActive`, one definition, no drift) both for
  interactive plan changes and a new daily scheduled BullMQ sync.
  Inbound webhooks: raw-body HMAC signature verification, TWO idempotency
  layers (Redis + a `BillingEvent` DB-level backstop — the exact use case
  0.10's idempotency primitive was earmarked for), and direct (not
  generic-listener) audit writes. `PAST_DUE` gates features (0.6's
  existing resolution, unchanged); only a fully Stripe-canceled
  subscription suspends the tenant — the real tie-in to 4.1's
  `TENANT_STATUS` enforcement. Proration: a pure, unit-tested Decimal
  PREVIEW locally, the AUTHORITATIVE charge always recorded from Stripe's
  own webhook. AMC (annual maintenance) invoicing is the platform's
  invoice-only bridge for lifetime tenants, who otherwise never touch
  Stripe. New tenant-portal `/billing` (RBAC-gated `billing.manage`) and
  vendor-console `/billing` + per-tenant billing card surfaces. See
  [`docs/conventions/billing.md`](./docs/conventions/billing.md).

- **4.3** — White-label / branding (Phase 4's final slice, lighter than
  4.1/4.2 by design — mostly a theming layer CONSUMING systems that
  already exist): a `TenantBranding` row (logo/colors/product name/login
  copy/email identity/gated full-rebrand bit) resolved through one
  hot-path-cached service (Redis, the same `REDIS_CLIENT` token
  idempotency/rate-limiting already use) and applied across `apps/portal`,
  `apps/mobile`, and outbound email (`{{productName}}` now interpolates
  into notification templates). A real bug this step's OWN Playwright
  suite caught and fixed: both web/mobile `BrandingProvider`s must
  re-fetch when the auth context's `user` changes, not just once on
  mount, or a fresh login under header-based tenant resolution shows
  stale default branding forever. Branded custom domains extend 0.3's
  EXISTING `custom_domain` resolution strategy (now gated on a real
  `verificationStatus === 'VERIFIED'` check, DNS-TXT-proven) plus a
  `CERT_PROVIDER` TLS-provisioning seam (mock bound by default; a real
  ACME client is a documented, `NotImplementedException` seam — genuinely
  can't be exercised in this environment). Full rebrand (hiding the
  "Powered by" identity) is ENTERPRISE-gated via the EXISTING 0.6
  `@RequireFeature` mechanism, re-checked LIVE on every read so a lapsed
  entitlement restores vendor identity immediately. Vendor oversight
  (`apps/admin`'s new `/branding`) mirrors 4.2's READ-both-roles/
  MANAGE-owner-only split, every action dual-audited exactly like 4.1/4.2.
  See [`docs/conventions/white-label.md`](./docs/conventions/white-label.md).

- [x] **4.1** Vendor super-admin console — platform admin identity/MFA
      (separate from tenant `User`), least-privilege platform roles,
      tenant lifecycle (`TENANT_STATUS` now enforced), Country Pack
      authoring/versioning, usage metrics, cross-tenant audit read, and
      permission-gated/time-boxed/loudly-audited impersonation. `apps/admin`
      built out from its prior placeholder. See
      [`docs/conventions/vendor-console.md`](./docs/conventions/vendor-console.md).
- [x] **4.2** SaaS billing via Stripe (SaaS-mode only) — real
      `Subscription`-state production replacing the 0.6 stub, seat
      metering, the Stripe adapter seam (real/mock), signed/idempotent
      inbound webhooks, non-payment → suspension, proration preview vs.
      the authoritative charge, AMC invoicing for lifetime tenants, and
      tenant-portal + vendor-console billing surfaces. See
      [`docs/conventions/billing.md`](./docs/conventions/billing.md).
- [x] **4.3** White-label / branding — per-tenant `TenantBranding` (logo,
      colors, product name, login copy, email identity), hot-path Redis-
      cached resolution applied across `apps/portal`/`apps/mobile`/
      outbound email, branded custom domains extending 0.3's resolution
      (DNS-verified) + a TLS-provisioning seam, the gated (ENTERPRISE-
      only, live-re-checked) full-rebrand capability, and vendor oversight
      (`apps/admin`) with dual audit. See
      [`docs/conventions/white-label.md`](./docs/conventions/white-label.md).

**PHASE 4 COMPLETE.** Vendor super-admin console (4.1) + SaaS billing via
Stripe (4.2) + white-label/branding (4.3) — the platform is now a
commercially operable SaaS AND on-prem product built entirely on top of
Phase 0–3's foundation.

- **3.5.1** — Data migration & onboarding toolkit (Phase 3.5's first
  slice, the go-live enabler): a two-phase `ImportBatch`
  (VALIDATE/dry-run — proven never to write, via a deliberate
  transaction-rollback sentinel, not a second hand-maintained "preview"
  code path — then COMMIT, refused unless the last dry run succeeded)
  importing BRANCH/DEPARTMENT/DESIGNATION/COST_CENTER (direct writes, no
  dedicated service exists for these), EMPLOYEE (routed through the REAL
  1.1 `EmployeeService`, so country-driven required fields/encryption/
  custom fields are enforced identically to a direct API call, plus
  manager-by-employeeCode linking resolved after every row is staged),
  LEAVE_BALANCE opening balances (routed through 1.2's `LeaveBalanceService`,
  a new additive `setOpeningBalance` — a SET, not the existing `adjust()`
  action's DELTA), and scoped-down, read-only ATTENDANCE_HISTORY/
  PAYSLIP_HISTORY (two new dedicated tables, never the real recomputed/
  tax-engine-driven ones). Natural-key upsert in every importer plus the
  batch's own status-machine guard make re-running an import safe.
  CSV/XLSX column mapping (a NEW `xlsx` dependency), reusable
  `ColumnMappingTemplate`s, a downloadable per-row CSV error report,
  uploaded-file purge after a retention window, and both a tenant
  self-serve portal wizard (`migration.manage`) and a vendor/platform
  onboarding surface on a tenant's behalf (`TENANT_MIGRATION_MANAGE`,
  dual-audited exactly like 4.1/4.2/4.3's own platform actions). See
  [`docs/conventions/data-migration.md`](./docs/conventions/data-migration.md).

- **3.5.2** — Benefits administration (Phase 3.5's second slice): tenant-
  configurable `BenefitPlan`/`BenefitPlanTier` mirroring
  `PayrollComponentDefinition`'s own `FIXED_AMOUNT`/`PERCENTAGE_OF_BASE`/
  `FORMULA` cost structure field-for-field (`FORMULA` reusing 0.5's closed
  `Expr` AST as-is), one cost split into an employee deduction + employer
  contribution via `employeeSharePercent`/`employerSharePercent`;
  `BenefitEnrollment` (admin-assigned or ESS self-elected, reusing 1.1's
  `EmployeeDependent` directly, optional approval via a REAL 0.7
  `WorkflowInstance` — THE RULE, zero bespoke logic). THE BOUNDARY, same
  shape as payroll.md's own: this module never computes pay —
  `PayrollRunProcessor` gained one additive `mergeBenefitContributions`
  step (pure functions imported directly, no module coupling either
  direction) mirroring 3.1's expense-reimbursement hand-off exactly,
  `PayrollEngineService` itself untouched. Country-mandated STATUTORY
  schemes needed ZERO payroll-side wiring at all — the engine already
  applies every resolved CountryPack `statutory.components` entry
  generically since 0.5/2.1; this step added real asymmetric
  employee/employer statutory data to BOTH reference packs for the first
  time (US: `state_disability_insurance`; Qatar: `grsia_pension_employee`/
  `_employer`, closing a gap the QA pack's own comment had flagged as
  "deliberately out of scope" since 0.5) plus a third, ad-hoc Pakistan
  pack (EOBI-style) proving the divergence generically — updating five
  pre-existing tests' hardcoded net-pay/statutory assertions as a real,
  foreseeable ripple effect, all green with the new numbers. Cost
  reporting reads ALREADY-COMPUTED data only (no new rollup table), field-
  level gated behind `salary.view`. New `apps/portal` pages `/benefits`
  (ESS) and `/benefits/admin` (plan authoring — `FORMULA` plans
  deliberately not authorable through the form, the same gap
  `payroll.ts`'s own `UpsertPayrollComponentInput` already carries). See
  [`docs/conventions/benefits.md`](./docs/conventions/benefits.md).

- **3.5.3** — E-signatures (Phase 3.5's third slice): a generic,
  polymorphic `SignatureRequest`/`SignatureSigner` model (internal
  `User`-linked signers via ESS, or external no-account signers via a
  scoped, expiring, single-document capability token — the SAME indexed-
  prefix + argon2id-hash pattern 3.3's `ApiKeyService` already establishes,
  never a JWT/RBAC credential), sequential/parallel signing via the
  signer's own `order` column — a small, purpose-built mechanism
  deliberately NOT the 0.7 workflow engine, mirroring exactly the
  reasoning 2.3's checklist mini-engine already gives for itself. THE
  EVIDENTIARY TRAIL is the real core: a SHA-256 document hash captured at
  creation and re-verified at every signing, an append-only
  `SignatureEvent` table made DB-immutable via the identical
  `audit_log`-style `REVOKE UPDATE/DELETE` migration (proven directly
  against Postgres), a generated signature CERTIFICATE PDF (via the same
  `pdfkit`/DejaVu-font approach 2.1's payslips established) as a SEPARATE
  downloadable artifact, and a live tamper-evidence re-verification route.
  Two real integrations, both additive: an Offer's acceptance IS its
  signature — the completion listener calls the REAL, unmodified
  `OfferService.accept`, which already cascades into the existing 2.3
  onboarding trigger with zero Recruitment/Onboarding changes; a Policy
  gains one additive `requiresSignature` column and
  `PolicyService.acknowledge` gains one additive bypass parameter, so a
  signed acknowledgment produces the SAME `PolicyAcknowledgment` row the old
  click-based flow always did, plus the full trail. External-signer email
  delivery calls the 0.8 notification hub's `EMAIL_PROVIDER` DIRECTLY
  (one additive export from `NotificationsModule`) since that hub's
  recipient model is inherently `User`-keyed and an external signer has no
  `User` row. Honestly scoped: this is a strong tamper-evident MECHANISM,
  not a legal determination of sufficiency under any specific
  e-signature law (eIDAS/ESIGN/UETA/etc.) — that boundary is stated
  directly in the UI, the same compliance-boundary framing payroll.md/
  benefits.md already take for their own domains. See
  [`docs/conventions/e-signatures.md`](./docs/conventions/e-signatures.md).

- **3.5.5** — A real, production-shaped Pakistan `CountryPack` — pure
  AUTHORING work, zero engine/schema/evaluator changes: replaces the ad-hoc
  "Pakistan-style" test pack step 3.5.2 created directly inside
  `benefits.e2e-spec.ts` (never seeded) with a real pack in
  `seed-country-packs.ts`, exactly like US/QA. PKR/Sat-Sun weekend/RTL
  Urdu (`locale.rtl: true` — proving the i18n framework's RTL wiring
  generalizes beyond Qatar's Arabic, since `ur` was already sitting unused
  in `@hrm/shared`'s RTL whitelist)/`MONDAY` first-day-of-week (a genuinely
  different choice from both existing packs); a single progressive
  `income_tax` layer (the SAME `PROGRESSIVE_BRACKETS` algorithm the US
  federal layer already uses); a wage-ceiling-based EOBI pair
  (`PERCENTAGE`+`cap`, the SAME shape the US pack's FICA social-security
  layer already uses for its own wage-base cap) plus a Provident Fund pair,
  four statutory components total; `["CNIC","NTN"]` required employee
  fields (the same opaque-key mechanism `EmployeeService` already enforces
  for US/QA, zero new code); a Sat/Sun-weekend/Urdu-Islamic public-holiday
  calendar with six real fixed-date national holidays and four lunar
  (Eid/Ashura) holidays seeded as explicit, clearly-flagged
  yearly-reconfirmation placeholders (the schema has no "TBD date" — the
  warning lives in the holiday's own `name` field). **Every
  legally-sensitive figure — tax slabs, EOBI rate/ceiling, PF rate — carries
  its own explicit `// VERIFY:` comment** naming exactly what to confirm
  and against what source (FBR/EOBI/the client's PF trust deed) before real
  payroll runs against it — a more insistent version of the "illustrative,
  not certified" framing US/QA already carry, since this pack is meant as a
  real client's actual starting point. `country-packs.e2e-spec.ts`'s core
  "same code path, divergent behavior" proof gains a THIRD branch (US/QA/PK)
  through the identical endpoint; `benefits.e2e-spec.ts`'s statutory-schemes
  proof and payroll-run proof are rewritten against the real pack's own
  declared rates instead of the retired ad-hoc fixture. See
  [`docs/conventions/pakistan-pack.md`](./docs/conventions/pakistan-pack.md).

- **3.5.4** — Statutory / government reporting (Phase 3.5's FINAL slice,
  closing the gap 3.5.5's own entry above flagged as deferred): GENERATES
  periodic government filing forms/exports FROM already-FINALIZED
  `PayrollRun` data (2.1) — never recomputes a figure, the same "only a
  genuinely final run" gate `PayrollBankExportService`'s bank export
  already enforces. A country-extensible framework: `StatutoryReportDefinition`
  (a global, RLS-exempt CATALOG row per country+report code, `hrm_app`
  `SELECT`-only, the same posture `CountryPack` takes) plus
  `StatutoryReportGeneratorRegistry` (a plain `reportCode -> generator`
  lookup, the SAME shape payroll's own `BankExportAdapterRegistry`
  establishes) plus `GeneratedReport` (the tenant-scoped register, ordinary
  RLS, a single derived `periodKey` string sidestepping the NULL-is-
  distinct trap `PayrollRun`'s own FINAL_SETTLEMENT seam needed hand-
  written partial indexes for). Pakistan ships four concrete reports —
  monthly income tax withholding (FBR), EOBI contribution (wage-ceiling-
  capped), Provident Fund contribution, and an annual salary/tax statement
  that GROUPS BY employee across every finalized month in the year — every
  generator reading the Pakistan pack's own `componentBreakdown` keys
  verbatim, never recomputing them. Generation is a `STATUTORY_REPORT_QUEUE`
  BullMQ job (the SAME producer/`WorkerHost` shape `PayrollRunQueueService`/
  `PayrollRunProcessor` establish), rendering BOTH a PDF (reusing payslips'
  `pdfkit`+DejaVu-font approach, RTL-aware via the SAME `isRtlLanguage`
  mechanism, this codebase's first genuine per-employee PDF TABLE) and a
  CSV (reusing the bank-export adapter's plain hand-escaped approach) to
  1.1's `StorageService`/MinIO. **THE COMPLIANCE BOUNDARY**: report
  STRUCTURES are production-ready; each report's own `complianceNote`
  states that its EXACT current form layout/field/submission requirements
  must be verified against FBR/EOBI/the relevant authority before real
  filing — shown on the generation UI AND printed directly on the
  generated PDF itself. Two new TENANT_ADMIN/HR_MANAGER-only permissions
  (`statutory_report.generate`/`.read`, the same tier `PAYSLIP_VIEW`/
  `BENEFITS_MANAGE` occupy); a new `apps/portal` admin-console page
  (`/statutory-reports`) — deliberately no ESS variant, so no RTL proof
  applies to the page itself (the Pakistan pack's RTL rendering is instead
  exercised inside the downloaded PDF). See
  [`docs/conventions/statutory-reporting.md`](./docs/conventions/statutory-reporting.md).
  **Phase 3.5 is now COMPLETE.**

- **5.1** — Data-layer scale hardening (Phase 5's first slice): a real
  PgBouncer (transaction pooling mode) fronting the primary, proven
  RLS-safe under forced connection reuse (`current_tenant`'s
  `set_config(..., true)` resets at COMMIT exactly when a pooled
  connection returns to the pool — no leakage window exists); a GENUINE
  Postgres streaming read replica (`pg_basebackup`-bootstrapped, not a
  mock) with RLS proven identical to the primary and read-after-write
  safety proven via a deliberate, controlled replication-lag experiment
  (`pg_wal_replay_pause`); and three tenant-scoped Redis caches (resolved
  country packs, org/branch structure, permissions) with immediate
  invalidation-on-write, following 4.3's branding-cache shape exactly. A
  FOURTH cache (feature-flag/entitlement) was built, then deliberately
  REVERTED after the existing `licensing-saas.e2e-spec.ts` suite
  empirically proved it could serve stale entitlement whenever a
  `Subscription` row is written outside the cache's own invalidation
  hooks — a real, documented finding, not a theoretical caveat. Local
  dev/test's own default connection stays direct (not the pooler) — an
  empirical call, not caution alone, after routing the full suite through
  it surfaced a real (non-correctness) latency characteristic for one
  timing-sensitive test class; the pooler is fully proven and is a
  one-env-var production cutover. See
  [`docs/conventions/scaling-data-layer.md`](./docs/conventions/scaling-data-layer.md).
- **5.2** — Table partitioning + archival (Phase 5's second slice): turns ON
  the native Postgres `PARTITION BY RANGE` partitioning `attendance_records`
  (1.3) and `audit_log` (0.9) were deliberately built PARTITION-READY for
  since day one — plus `platform_audit_log` (4.1), whose own doc comment
  had explicitly flagged it for this same treatment — via one additive,
  hand-written migration (rename-aside, recreate as a native partitioned
  table with identical columns/PK/FKs/indexes/RLS/grants, bootstrap
  partitions, copy every row, drop the old table); `signature_events` was
  assessed and deliberately NOT partitioned (no partition-key-inclusive PK,
  much lower/differently-bounded growth). RLS + `audit_log`'s DB-level
  immutability proven to hold IDENTICALLY through the partitioned parent
  (a GRANT on the parent does not even propagate to a partition addressed
  directly by name — partitions are, if anything, more locked down by
  default); partition pruning proven via a real `EXPLAIN`. An idempotent
  `hrm_ensure_range_partitions` Postgres function (owner-only, `hrm_app` has
  no `CREATE` privilege at all) backs a daily scheduled BullMQ job
  (`PartitionMaintenanceService`) that keeps every managed table's
  partitions created ahead of time — no manual partition creation, ever.
  A monthly scheduled archival job (`PartitionArchivalService`) exports an
  aged partition's rows (gzip JSONL, SHA-256 checksummed) to the SAME
  MinIO/S3 seam 1.1 established, and ONLY once that upload durably
  succeeds does it detach+drop the partition — proven to never disturb
  RLS/immutability for the data that remains. `TenantRetentionOverride` is
  the honestly-scoped Phase 6.1 GDPR/data-residency SEAM (settable/
  readable, dual-audited) — not yet a completed per-tenant purge, since a
  single partition holds every tenant's rows for its date range. See
  [`docs/conventions/partitioning-archival.md`](./docs/conventions/partitioning-archival.md).
- **5.3** — Horizontal scaling, Kubernetes, and regional deployment (Phase
  5's third slice, deployment-oriented — make the app provably
  horizontally scalable and produce production-ready orchestration,
  rewrite zero business logic): a systematic in-process-state audit found
  only already-documented, harmless exceptions (0.10's own
  `SystemLoadService` counter; a memoized read of an immutable,
  identically-mounted license-key file) — **proven, not argued**, by a new
  `deployment-scaling.e2e-spec.ts` that compiles TWO separate `AppModule`
  instances and shows rate-limit/idempotency/circuit-breaker state and JWT
  auth all behave identically across them via Redis. A genuine second
  entrypoint (`worker.ts`, `NestFactory.createApplicationContext` — no
  HTTP listener, no controllers, every BullMQ processor still registers)
  plus one new env-driven switch (`PROCESS_ROLE=api` -> `autorun: false`
  on every `@Processor`, via `shouldAutorunWorkers()`) makes the api
  Deployment stop consuming queues once a dedicated worker Deployment
  exists — proven against the real BullMQ library, not just asserted.
  Multi-stage Dockerfiles for `apps/api` (one image serves the API, the
  worker, AND the migration Job, via `command:` alone), `apps/portal`, and
  `apps/admin` (`output: 'standalone'`) — all actually built/run locally,
  not just written. Production-ready `deploy/k8s/` manifests (plain YAML +
  Kustomize regional overlays, no Helm chart introduced this step):
  liveness/readiness wired to 0.10's real health checks, zero-downtime
  rolling updates, a `preStop` sleep complementing the app's own
  SIGTERM-driven drain, an HPA for the API (CPU/memory) and TWO options
  for the worker (a KEDA queue-depth `ScaledObject` reading BullMQ's own
  Redis lists directly, or a CPU-based fallback), PodDisruptionBudgets,
  one ingress convention (tenant subdomain + `/api` path split, reusing
  0.3's resolution unmodified), and a single per-release migration `Job`
  that the deploy pipeline waits on before any rollout — never a per-pod
  initContainer. Regional deployment is honestly scoped as the SEAM (a
  fully separate, shared-nothing stack per region, tenant->region pinning
  falling out of 0.3's existing subdomain resolution for free), explicitly
  NOT automatic cross-region enforcement — that is Phase 6.1, the same
  boundary 5.2 already drew for `TenantRetentionOverride`. Every claim is
  marked verified-locally (kustomize renders, Docker images actually
  built, the multi-instance e2e proof) vs. verified-at-deploy (a live
  HPA/KEDA scale event, DNS/cert-manager behavior — no cluster exists in
  this environment) rather than blurring the two. See
  [`docs/conventions/deployment-scaling.md`](./docs/conventions/deployment-scaling.md).

- [x] **3.5.1** Data migration & onboarding toolkit — see
      [`docs/conventions/data-migration.md`](./docs/conventions/data-migration.md).
- [x] **3.5.2** Benefits administration — plan config, statutory schemes
      (zero engine change), enrollment + optional workflow approval, the
      benefits→payroll input hand-off, cost reporting. See
      [`docs/conventions/benefits.md`](./docs/conventions/benefits.md).
- [x] **3.5.3** E-signatures — polymorphic signature requests, internal +
      external (token-scoped, no-account) signers, sequential/parallel
      signing, a tamper-evident/DB-immutable evidentiary trail + generated
      certificate, the Offer-acceptance and Policy-acknowledgment
      integrations, and the documented compliance boundary. See
      [`docs/conventions/e-signatures.md`](./docs/conventions/e-signatures.md).
- [x] **3.5.5** Pakistan country pack — a real, production-shaped
      `CountryPack` (PKR, Sat-Sun weekend, RTL Urdu, a progressive income
      tax layer, wage-ceiling-based EOBI + Provident Fund, CNIC/NTN
      required) replacing the ad-hoc 3.5.2 test pack, authored entirely
      with the EXISTING pack schema/rules engine — zero engine/schema/
      evaluator changes. Every legally-sensitive figure is an explicit,
      documented VERIFY-placeholder requiring sign-off from a qualified
      Pakistani tax/payroll professional before real payroll use. See
      [`docs/conventions/pakistan-pack.md`](./docs/conventions/pakistan-pack.md).
- [x] **3.5.4** Statutory / government reporting — a country-extensible
      framework (`StatutoryReportDefinition` catalog + a pluggable
      `StatutoryReportGeneratorRegistry`, the same shape payroll's own
      `BankExportAdapterRegistry` establishes) generating periodic
      government filing forms/exports FROM already-FINALIZED payroll data,
      never recomputing a figure. Pakistan ships four concrete reports
      (monthly income tax withholding, EOBI contribution, Provident Fund
      contribution, an annual salary/tax statement); PDF (RTL-aware,
      reusing payslips' rendering approach) + CSV output via a BullMQ job;
      the "verify current form specifics before filing" compliance
      boundary printed directly on every generated PDF. See
      [`docs/conventions/statutory-reporting.md`](./docs/conventions/statutory-reporting.md).

**PHASE 3.5 COMPLETE.** Data migration (3.5.1) + Benefits administration
(3.5.2) + E-signatures (3.5.3) + Pakistan country pack (3.5.5) + Statutory
reporting (3.5.4) — the go-live/compliance layer for a real first client.

- [x] **5.1** Data-layer scale hardening — PgBouncer connection pooling
      (proven RLS-safe under forced connection reuse), a real Postgres
      streaming read replica (RLS-identical, read-after-write proven via a
      controlled-lag experiment), and tenant-scoped Redis caching (country
      packs, org/branch structure, permissions) with immediate
      invalidation-on-write — plus one cache (entitlement) deliberately
      reverted after being empirically proven unsafe. See
      [`docs/conventions/scaling-data-layer.md`](./docs/conventions/scaling-data-layer.md).
- [x] **5.2** Table partitioning + archival — native `PARTITION BY RANGE`
      (additive conversion) for `attendance_records`/`audit_log`/
      `platform_audit_log`, RLS + `audit_log` DB-level immutability proven
      identical on partitions, partition pruning proven; an automated,
      idempotent ahead-of-time partition-creation job (no manual partition
      creation, ever); age-based archival to object storage (export-then-
      detach-then-drop, proven never to disturb remaining data) with a
      configurable retention policy and the Phase 6.1 GDPR seam
      (`TenantRetentionOverride`). `signature_events` assessed and
      deliberately not partitioned (documented why). See
      [`docs/conventions/partitioning-archival.md`](./docs/conventions/partitioning-archival.md).
- [x] **5.3** Horizontal scaling, Kubernetes, and regional deployment —
      an audited-not-assumed statelessness proof (two independent
      `AppModule` instances sharing rate-limit/idempotency/circuit-breaker
      state and JWT auth via Redis), a genuine `worker.ts` entrypoint +
      `PROCESS_ROLE`-gated `autorun` split from the api process (proven
      against real BullMQ), Docker images for api/worker/portal/admin,
      production-ready `deploy/k8s/` manifests (probes wired to 0.10's
      real health checks, zero-downtime rollout, HPA/KEDA autoscaling,
      PodDisruptionBudgets, a single waited-on migration `Job`), and the
      regional-deployment SEAM (a fully separate stack per region,
      tenant->region pinning via 0.3's existing subdomain resolution) —
      explicitly not Phase 6.1's cross-region enforcement. See
      [`docs/conventions/deployment-scaling.md`](./docs/conventions/deployment-scaling.md).
- [ ] **5.4** Observability + load testing — deferred.

**Phase 5 remaining: 5.4 (observability + load testing), deferred.**

- [ ] **Phase 6** — _scope not yet defined_
