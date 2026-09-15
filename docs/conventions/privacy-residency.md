# Data privacy & residency

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 6.1 (Phase 6's first slice) — `packages/db`, `packages/shared`,
`apps/api/src/privacy`, `apps/api/src/platform/privacy`,
`apps/api/src/tenancy/tenant-scope.interceptor.ts`, `apps/portal`,
`apps/admin`, `deploy/k8s/`. This is the capability layer for legally
holding personal data and honoring data-subject rights (GDPR-style,
applicable broadly, including the first client's own jurisdiction — see
[pakistan-pack.md](./pakistan-pack.md)). It consumes, and never weakens,
every isolation/immutability guarantee this codebase already has: RLS
([tenancy-rls.md](./tenancy-rls.md)), the DB-level-immutable `audit_log`
([audit-custom-fields.md](./audit-custom-fields.md)), the 5.2 retention/
archival seam ([partitioning-archival.md](./partitioning-archival.md)), and
the 5.3 regional-deployment seam ([deployment-scaling.md](./deployment-scaling.md)).
The primary PII subjects this module acts on are the Employee
([employee.md](./employee.md)) and the Candidate
([recruitment-lifecycle.md](./recruitment-lifecycle.md)), plus a bare
tenant `User` for the rare case of an account with no linked Employee.

## The model

Six new tables, mirroring two already-established shapes in this schema:

- **Tenant-scoped, ordinary RLS** (the SAME pattern every other tenant-owned
  table already uses): `DataSubjectRequest` (one export/erasure request —
  `requestType`/`subjectType`/`subjectId`/`status`/`erasureSummary`/
  `resultStorageKey`, plus `requestedByUserId`/`initiatedByPlatformAdminId`/
  `systemInitiated` naming WHO or WHAT triggered it — a real person, the
  vendor acting on the tenant's behalf, or the scheduled retention job),
  `ConsentRecord` (an append-only log of grant/revoke decisions — recording
  a new one is always an INSERT, never an update-in-place, so a subject's
  full consent HISTORY survives), `TenantDataRetentionOverride` (a tenant's
  own retention preference for one `DataCategory` — see below).
- **Platform-wide catalog, no `tenantId`, `hrm_app` gets SELECT only**
  (the SAME exemption/read posture `CountryPack`/`PartitionedTableConfig`
  already establish): `DataProcessingRegisterEntry` (the Record of
  Processing Activities a GDPR-style regime expects — one row per
  `DataCategory`, vendor-authored, read live by every tenant),
  `SubProcessorRecord` (the vendor's own sub-processor disclosure — object
  storage, Stripe, the email provider, Sentry, seeded with illustrative
  entries naming this codebase's own real adapter seams), `DataRetentionPolicy`
  (the platform DEFAULT retention/erasure-action per `DataCategory`, one
  row per category, seeded with illustrative defaults — see the erasure
  policy table below).

`DataCategory` is a closed, six-value enum (`EMPLOYEE_PROFILE`,
`EMPLOYEE_POST_EXIT`, `CANDIDATE_RECORDS`, `PAYROLL_TAX_RECORDS`,
`AUDIT_TRAIL`, `DOCUMENTS`) — a fixed taxonomy this module's OWN engine
branches on, unlike `WorkflowInstance.entityType`'s free-form-string
pattern. `DATA_CATEGORIES_BY_SUBJECT_TYPE` (`packages/shared`) is a pure
code constant naming which categories apply to which `DataSubjectType`
(`EMPLOYEE`/`CANDIDATE`/`USER`) — the same "fixed, reviewed taxonomy, not
tenant-customizable data" posture `EDITION_FEATURES` documents for itself.

### Why `TenantDataRetentionOverride` is a SEPARATE table from 5.2's `TenantRetentionOverride`, and why it actually applies

5.2's `TenantRetentionOverride` (keyed by `PartitionedTableName`) is
documented as INFORMATIONAL only — a single monthly PARTITION physically
holds every tenant's rows for that date range, so there is no way to
"archive this partition for tenant A but not tenant B." This step's
`TenantDataRetentionOverride` (keyed by `DataCategory`) has no such
obstacle: `EMPLOYEE_POST_EXIT`/`CANDIDATE_RECORDS` are enforced with an
ordinary `WHERE tenant_id = ?` row-level query, so a tenant's own
preference genuinely changes what the scheduled sweep does for THAT
tenant — see `ProcessingRegisterService.effectiveRetentionPolicies`
(tenant override wins when present, else the platform default) and
`RetentionEnforcementService.sweepTenant`, which reads exactly that
resolved value.

## Data-subject rights

### Export — a structured JSON manifest, plus the actual files

`DataExportService.run` aggregates a subject's data across every module
that holds it, entirely via PLAIN `tx.<model>.findMany` reads (no
dedicated service to route through for a cross-cutting, read-only
aggregation — the same "no service fits, read/write the table directly"
posture [data-migration.md](./data-migration.md)'s reference-table
importers already establish, applied here to a READ):

- **Employee subject**: profile, dependents, emergency contacts, custom
  fields, leave balances/requests, attendance records/regularizations,
  payroll run lines + payslip metadata, benefit enrollments/contributions,
  goals/appraisals/review assignments, expense claims, asset assignments,
  helpdesk tickets, LMS enrollments/certifications, consent records, and
  up to 500 of their own most recent `audit_log` entries.
- **Candidate subject**: profile, applications, interviews, scorecards,
  offers, onboarding process, consents, audit trail.
- **User subject** (no linked Employee): the bare account plus its own
  consent/audit trail.

**"JSON + files", not just JSON describing files exist.** Every
`EmployeeDocument`/resume the subject owns is actually re-downloaded via
the EXISTING `StorageService` and re-uploaded alongside the manifest at
`privacy-exports/<tenantId>/<requestId>/files/<documentId>-<fileName>` —
proven byte-identical in `privacy.e2e-spec.ts` (a real uploaded document,
downloaded back from the export's own copy, compared byte-for-byte against
the original). `export.json` lands at
`privacy-exports/<tenantId>/<requestId>/export.json`, downloadable via
`GET /privacy/requests/:id/export` (streamed the SAME way payslip/
bank-export downloads already are).

### Erasure — the per-category policy matrix, and the audit-immutability reconciliation

**The hard constraint this step had to satisfy**: `audit_log` is DB-level
immutable BY DESIGN (`hrm_app` has `UPDATE`/`DELETE` revoked — see
[audit-custom-fields.md](./audit-custom-fields.md)), and payroll/tax
records must legally persist. "Erase this person's data" therefore cannot
mean "delete every row that ever mentioned them" — it means a
CATEGORY-BY-CATEGORY policy, explicit and documented:

| `DataCategory`        | Applies to                                     | Action             | Why                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EMPLOYEE_PROFILE`    | Employee, while `ACTIVE`                       | RETAIN_LEGAL       | An active employment relationship needs the record; erasure is refused (`409`) until the employee is offboarded (`status: TERMINATED`) — the same "hand off to the real system" boundary this codebase already draws elsewhere.                                                                                                |
| `EMPLOYEE_POST_EXIT`  | Employee, once `TERMINATED`                    | ANONYMIZE          | `firstName`/`lastName`/`personalEmail`/`phone`/`dateOfBirth`/`gender`/`statutoryFields`/bank fields are scrubbed; `employeeCode`, `branchId`, `status`, dates are KEPT — `PayrollRunLine`/`AttendanceRecord`/etc. still hold a live FK to this row and must keep working.                                                      |
| `CANDIDATE_RECORDS`   | Candidate (never hired, or still mid-pipeline) | HARD_DELETE        | No employment relationship, no legal retention need. The whole ATS trail (`Application`/`Interview`/`InterviewScorecard`/`Offer`/`OnboardingProcess`) cascades away via the EXISTING `onDelete: Cascade` FKs — zero new cascade logic. Refused if the candidate already became a real Employee (erase via `EMPLOYEE` instead). |
| `PAYROLL_TAX_RECORDS` | PayrollRunLine/PayslipDocument                 | RETAIN_LEGAL       | Statutory record-keeping (see [payroll.md](./payroll.md)). `PayrollRunLine` was ALREADY designed (2.1) to store no direct PII — amounts plus an `Employee` foreign key only — so anonymizing the Employee row IS what scrubs identifying data from this category, with ZERO payroll-schema changes.                            |
| `AUDIT_TRAIL`         | `audit_log` rows naming the subject            | ANONYMIZE (within) | Never row-deleted (immutability holds). See below.                                                                                                                                                                                                                                                                             |
| `DOCUMENTS`           | `EmployeeDocument`                             | HARD_DELETE        | Metadata row and object-storage bytes both removed — no legal need identified for this phase's scope (a document independently known to require longer retention is a documented, deliberate gap — see below).                                                                                                                 |

**Anonymize-WITHIN `audit_log` — the reconciliation, proven, not just
argued.** `PrivacyErasureService.anonymizeAuditTrail` is the ONE deliberate,
narrow exception in this whole codebase that writes to `audit_log` through
the OWNER `prisma` client instead of a tenant-scoped `appPrisma`
transaction — the exact same "infra/maintenance operation, not a
tenant-scoped one" reasoning `PartitionMaintenanceService`/
`PartitionArchivalService` already use for their own owner-client-only DDL.
It finds every `audit_log` row naming the subject (`entityType`/`entityId`,
or `actorUserId` for a bare `User` subject), deep-walks each row's
`before`/`after`/`metadata` JSON, and replaces any STRING VALUE that
exactly equals one of the subject's own captured PII values (name, email,
phone) with a fixed `[ERASED]` marker — structure and every OTHER value
untouched — then `UPDATE`s the row (never `DELETE`s it) via
`auditLog.updateMany({ where: { id } })`, explicitly scoped by `tenantId`
on the read side even though the owner client itself bypasses RLS.

Proven directly in `privacy.e2e-spec.ts`, the same proof SHAPE
`audit-log-immutability.spec.ts` already established for the unmodified
path: after an employee's erasure, their `audit_log` rows still EXIST
(same count), no longer contain their name/email anywhere in `before`/
`after`, AND `hrm_app` STILL cannot `UPDATE`/`DELETE` them directly
(`appPrisma.auditLog.updateMany(...)` still fails with `permission
denied`) — the erasure engine's owner-client path is the ONLY way this
content ever changes, never a new gap in `hrm_app`'s own grants.

**The linked `User`, if any, is disabled and its tokens revoked** — reusing
`TokenService.revokeAllForUser` + `User.status = 'DISABLED'`, the EXACT
same primitive [recruitment-lifecycle.md](./recruitment-lifecycle.md)'s
offboarding bridge already established, plus the email is replaced with an
opaque `erased-<id>@erased.invalid` placeholder (an email column stays
per-tenant-unique; a real address must never be reused as a "this account
is gone" marker). Proven directly: a token issued before erasure is
rejected (`401`) immediately after, on its very next use.

## Consent tracking

`ConsentService.record`/`.list` — a plain, append-only log
(`ConsentRecord`), one row per grant/revocation DECISION, never updated in
place. `purpose`/`source` are free-form strings, not closed enums (which
purposes a given tenant/country actually needs to track is not this
codebase's call to fix) — `POST /privacy/consents` /
`GET /privacy/consents` (tenant-scoped, `privacy.manage`).

## The processing register + sub-processor disclosure + effective retention policy

Three read surfaces, all reading the platform-authored catalog LIVE (the
same "one shared catalog, read live" posture `CountryPack` already
establishes): `GET /privacy/register` (the ROPA — what data, why, legal
basis, per `DataCategory`), `GET /privacy/sub-processors` (the vendor's own
disclosure — illustrative seed rows naming this codebase's REAL adapter
seams: S3-compatible object storage, Stripe, the transactional-email
provider, Sentry), `GET /privacy/retention-policies` (the EFFECTIVE
retention per category — the platform default, or this tenant's own
override when set, plus whether that category is `autoEnforced` by the
scheduled sweep at all). Authoring the register/sub-processor catalog and
the platform-default retention policy is a vendor/platform operation
(`PUT /platform/privacy/retention-policies/:category`,
`POST`/`PUT`/`DELETE /platform/privacy/sub-processors`, `PRIVACY_MANAGE`,
owner-only) — `hrm_app` holds no write grant on any of the three tables at
all.

## Retention enforcement — building directly on 5.2's own scheduled-job shape

`RetentionEnforcementService` — the SAME "orchestrate -> fan out" scheduled
BullMQ shape `AnalyticsRollupService`/`PartitionMaintenanceService` already
establish (`onModuleInit` registers a daily repeatable job, `0 6 * * *`
UTC, offset from every other scheduled job's own cron), plus a manual
trigger (`POST /platform/privacy/retention-sweep/run`, `PRIVACY_MANAGE`) —
the identical "scheduled + manual, both call the same method" shape
`POST /platform/partitioning/ensure` already establishes.

Only `EMPLOYEE_POST_EXIT`/`CANDIDATE_RECORDS` are ever auto-enforced
(`AUTO_ENFORCEABLE_RETENTION_CATEGORIES`, `packages/shared`) — every other
category is either `RETAIN_LEGAL` by platform default or acted on only via
an explicit, on-demand `DataSubjectRequest`. For each live tenant (`TRIAL`/
`ACTIVE`, discovered via the owner `prisma` client's cheap `Tenant.findMany`
— the ONLY owner-client read in this service; the actual eligibility
scan/write runs inside that tenant's own `withTenantContext` transaction,
ordinary RLS, since there is no shared-partition obstacle here), the sweep
finds `TERMINATED` employees whose `terminatedAt` is older than the
resolved retention window (skipping any already anonymized — checked via a
prior `COMPLETED` `ERASURE` `DataSubjectRequest` for that subject, not a
sentinel string match) and stale candidates (`updatedAt` past the window,
never hired), and calls `PrivacyErasureService.run` — the EXACT SAME engine
an on-demand request uses, via
`DataSubjectRequestService.recordSystemErasure`, which ALSO writes a
terminal, `systemInitiated: true` `DataSubjectRequest` row purely as an
auditable record of what the scheduled job did. **One engine, two
callers — they can never define "erased" differently.**

Proven end to end in `privacy.e2e-spec.ts`: a tenant sets a 1-month
`TenantDataRetentionOverride` for `EMPLOYEE_POST_EXIT`, a manually
triggered sweep auto-erases a 3-months-stale terminated employee (and only
that one), and a `systemInitiated` `DataSubjectRequest` row records it.

### Post-exit employee data retention — the license-doc-review item, closed

This is the concrete instance of the "post-exit employee data retention"
gap named in this step's own brief: `EMPLOYEE_POST_EXIT`'s platform default
(84 months — the SAME illustrative 7-year statutory baseline this
codebase's own `AUDIT_LOG`/`PLATFORM_AUDIT_LOG` `PartitionedTableConfig`
rows already use) is now genuinely ENFORCED, configurable per tenant, and
proven by a real automated sweep — not merely documented as a future
intention.

## Residency enforcement — turning 5.3's seam into a real, tested invariant

5.3 left `Tenant.hostingRegion` and the regional-deployment TOPOLOGY (a
fully separate stack per region) as a documented SEAM: nothing actually
ROUTED or REJECTED traffic based on it (see
[deployment-scaling.md](./deployment-scaling.md) § Regional deployment).
This step closes that gap at the APPLICATION layer:
`TenantScopeInterceptor.assertResidency` reads `DEPLOYMENT_REGION` (a new
env var naming which region THIS running stack serves) and, when set,
rejects (`403`, before rate limiting or the DB transaction even opens — the
identical placement `BLOCKED_TENANT_STATUSES` already uses) any request
for a tenant whose own `hostingRegion` doesn't match. Wired into BOTH
authentication paths (the JWT/subdomain path AND the API-key path — see
`tenant-scope.interceptor.ts`).

**Unset (every local/CI run, and any single-region deployment) is a
complete no-op** — the same "no setup needed for local dev" posture this
codebase holds itself to everywhere else. `deploy/k8s/base/configmap.yaml`
now carries a `DEPLOYMENT_REGION` default, and BOTH existing region
overlays (`overlays/us-east-1/`, `overlays/me-south-1/`) patch it to their
own value — a region's own stack now provably refuses to serve a
foreign-region tenant, not merely "is expected to via DNS/ingress
convention."

**Verified locally**: `privacy-residency.e2e-spec.ts` sets
`DEPLOYMENT_REGION=us-east-1` ONCE, at module-load time — the SAME
"separate file per differing top-level config" discipline
`licensing-lifetime.e2e-spec.ts` (`LICENSE_MODE`) and
`resilience-pool-exhaustion-txn-start.e2e-spec.ts`
(`DB_POOL_SIZE`/`DB_POOL_TIMEOUT_SECONDS`) already establish, deliberately
NEVER toggled mid-file (this makes the proof independent of exactly when
`@nestjs/config`'s `ConfigService` snapshots `process.env`, rather than
resting on an assumption about that timing) — and proves a tenant pinned to
`us-east-1` is served normally while one pinned to `me-south-1` is rejected
with a message naming both regions.

**Verified-at-deploy, honestly, not glossed over**: genuine physical
isolation (a tenant's primary, replica, backups, and archives never
touching another region's Postgres/S3) is a property of the SEPARATE-STACK
topology 5.3 already established (each region's own Postgres + S3 bucket —
see `deploy/k8s/overlays/<region>/`'s own `S3_REGION`/`S3_BUCKET`
patches, which `StorageService`'s exports/archives already write through
unmodified) — this step's own contribution is the APPLICATION-LEVEL
guard that makes "this stack only serves its own region's tenants" an
enforced invariant rather than an operational convention a misconfigured
DNS/ingress rule could silently violate. A live cross-region deployment
(two real separately-provisioned regional stacks) is not exercisable in
this environment, the same honest boundary 5.3 already drew for itself.

### The first client's jurisdiction — a concrete case, not a hypothetical

Pakistan (the first real client — see
[pakistan-pack.md](./pakistan-pack.md)) is pinned to `me-south-1` (the SAME
region Qatar's own `CountryPack.hostingRegionHint` already advises — see
`packages/db/src/seed-country-packs.ts`) — `deploy/k8s/overlays/me-south-1/`
is this jurisdiction's own concrete residency case, its `kustomization.yaml`
now explicitly documenting this and flagging Pakistan's own
data-localization posture (State Bank of Pakistan / PECA considerations for
financial and personal data) as a real, jurisdiction-specific legal
question — a **VERIFY** item, the SAME "explicit, documented
VERIFY-placeholder" discipline pakistan-pack.md already holds every
legally-sensitive figure to, not resolved by this overlay alone.

## Platform (vendor) surfaces

`PlatformPrivacyController`/`PlatformPrivacyService`
(`platform/privacy/`) — `PRIVACY_READ` (both platform roles, support-safe)
vs. `PRIVACY_MANAGE` (`PLATFORM_OWNER` only), the SAME "READ is broad,
MANAGE is narrow" split `BILLING_READ`/`PARTITIONING_READ` already
establish:

- `GET /register` / `GET /retention-policies` / `PUT /retention-policies/:category`
  / `GET`/`POST`/`PUT`/`DELETE /sub-processors` — author the platform-wide
  catalog, dual-audited into `PlatformAuditLog`.
- `GET /residency-overview` — a cheap indexed read (`Tenant.findMany`, no
  per-tenant loop — the same "cheap reads only" posture
  `PlatformUsageService` already establishes) comparing every tenant's
  `hostingRegion` against THIS stack's own `DEPLOYMENT_REGION`, surfacing
  exactly the misconfiguration the interceptor's own guard would reject at
  request time.
- `GET /requests` — cross-tenant `DataSubjectRequest` oversight,
  filterable by tenant — itself an audited read (`platform.privacy.requests_read`),
  the SAME "reading the audit trail is itself audited" posture
  `PlatformAuditQueryService` already establishes.
- `POST /tenants/:tenantId/requests` — the platform creating a request ON A
  TENANT's behalf, reusing `DataSubjectRequestService.submit` UNCHANGED
  (opened via `withTenantContext` so RLS still applies even though the
  actor is a platform admin), dual-audited into BOTH the target tenant's
  own `audit_log` (`actorPlatform: true`) and `PlatformAuditLog` — the
  identical shape `TENANT_MIGRATION_MANAGE` already establishes.
- `POST /retention-sweep/run` — the manual trigger described above.

## Tenant portal + vendor console surfaces

`apps/portal`'s `/privacy` (`privacy.manage`, TENANT_ADMIN only): submit an
export/erasure request by subject type + id, poll request history
(download a completed export, read an erasure summary), view the
processing register/sub-processor disclosure, and set/clear a per-category
retention override. `apps/admin`'s `/privacy` (functional-over-fancy,
`PRIVACY_READ` both roles, `PRIVACY_MANAGE` owner-only client-side hint):
residency overview, platform retention policy, the processing register,
sub-processor CRUD, a manual retention-sweep trigger, and cross-tenant
request oversight.

## Known, documented gaps for this phase

Not required by this step's own test list, flagged so they aren't silently
forgotten: a document independently known to require LONGER legal
retention than its owning employee's own `EMPLOYEE_POST_EXIT` window has no
per-document override — `DOCUMENTS` erasure/retention is all-or-nothing per
employee today; `PayslipDocument`'s own rendered PDF (baked-in PII at
generation time) is retained under `PAYROLL_TAX_RECORDS`'s legal window and
is NOT redacted on an on-demand erasure request — a real, honest boundary
(a generated PDF's text cannot be selectively scrubbed the way a JSON
column can), stated plainly rather than silently glossed over; `USER`
subject erasure/export is deliberately minimal (no linked-Employee case is
handled by the `EMPLOYEE` path instead); there is no reminder/notification
when an export/erasure completes — the requester polls status, the SAME
"submit, then poll" posture [data-migration.md](./data-migration.md)
already establishes for itself; cross-region physical isolation itself is
verified-at-deploy only (see above), not exercisable in this environment.

Verified end-to-end over real HTTP by `apps/api/test/privacy.e2e-spec.ts`
(22 tests: RBAC deny-by-default; a complete, structured, byte-verified
export incl. a copied document file, audited, tenant-isolated; erasure
refused for an active employee and completing for a terminated one —
anonymizing the profile, deleting dependents/documents, disabling+revoking
the linked User, leaving the legally-retained `PayrollRunLine` completely
untouched, and anonymizing-within `audit_log` while proving `hrm_app`
STILL cannot `UPDATE`/`DELETE` it directly; a candidate erasure hard-deleting
the whole ATS trail via cascade with the same anonymize-within audit proof;
the scheduled retention sweep auto-erasing a stale terminated employee
honoring a tenant override; consent recording, the processing register,
sub-processor disclosure, and effective retention policy reads, all
tenant-isolated; the vendor console's cross-tenant oversight — dual-audited
on-behalf-of request creation, filterable cross-tenant listing that is
itself audited, sub-processor CRUD, the residency overview) plus
`apps/api/test/privacy-residency.e2e-spec.ts` (2 tests: a tenant pinned to
this deployment's own region served normally; the same tenant type pinned
to a different region rejected before any DB transaction opens). Full
`apps/api` suite: **586 tests, 64 suites, all green** (562 existing + 24
new), confirming zero regressions. Full-repo `pnpm build`/`pnpm lint` green
across every workspace, including the new `apps/portal`/`apps/admin`
`/privacy` pages.
