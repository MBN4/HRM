# Data migration & onboarding toolkit

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.5.1 — `packages/db`, `packages/shared`,
`apps/api/src/migration`, `apps/api/src/platform/migration`,
`apps/portal/src/app/(app)/migration`, `apps/admin/src/app/(app)/migration`.
See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "3.5.1 data migration &
onboarding toolkit" entry) for the full file list and verification notes.
This is the go-live enabler: it imports a new client's EXISTING employee/HR
data cleanly, safely, and with actionable error handling. It is a THIN
CONSUMER, the same posture 3.1's operations modules established — this
toolkit owns **zero** employee/leave/country-pack validation logic of its
own, and builds directly on [employee.md](./employee.md) (`EmployeeService`),
[leave.md](./leave.md) (`LeaveBalanceService`), [country-packs.md](./country-packs.md)
(indirectly, via those two services), [tenancy-rls.md](./tenancy-rls.md),
[auth-rbac.md](./auth-rbac.md), [notifications-queues.md](./notifications-queues.md)
(the BullMQ pattern), [audit-custom-fields.md](./audit-custom-fields.md), and
[vendor-console.md](./vendor-console.md) (the platform onboarding surface).
Nothing about any of those systems needed to change for this module to
exist.

## The core safety model: validate, then commit, never both at once

- **`ImportBatch` is a real state machine**, not a boolean flag:
  `UPLOADED -> VALIDATING -> DRY_RUN_COMPLETE -> COMMITTING -> COMMITTED` /
  `COMMITTED_WITH_ERRORS` / `FAILED`. A batch may be re-validated any
  number of times (re-running dry-run costs nothing — see below) but
  `POST /migration/batches/:id/commit` is refused (`409 Conflict`) unless
  `status = DRY_RUN_COMPLETE`. This status guard is itself the FIRST of
  two idempotency layers (see "Idempotency" below).
- **The dry-run mechanism is what makes this trustworthy without
  duplicating a single line of real validation logic.** Every importer's
  `processRow` (`apps/api/src/migration/importers/*.importer.ts`) calls the
  SAME real module service (`EmployeeService.create`/`.update`,
  `LeaveBalanceService.setOpeningBalance`, ...) whether it's being run as
  part of a dry run or a commit. The difference lives in exactly one place,
  `runImportRow` (`apps/api/src/migration/migration-row-runner.ts`):

  ```ts
  // COMMIT: run inside one transaction per row, keep the result.
  // DRY RUN: run inside one transaction per row, then throw a private
  // sentinel wrapping the result — forcing Postgres to roll the
  // transaction back regardless of whether the row "succeeded."
  ```

  A dry run can therefore never write to a target entity table
  (`branches`, `employees`, `leave_balances`, ...) **by construction, not
  by convention or by a second, separately-maintained "preview" code
  path.** Any real validation failure (a missing required statutory
  field, an unresolvable branch reference, ...) throws its own, different
  error and is reported identically on either path.

- **Every importer is a THIN adapter**, implementing `EntityImporter`
  (`apps/api/src/migration/importers/entity-importer.interface.ts`):
  `processRow(tx, tenantId, importBatchId, allowedBranchIds, mappedRow)`
  maps + coerces one row and calls the real write/validation; an optional
  `finalize(tx, tenantId, allowedBranchIds, commit, rows)` runs a SECOND
  pass over every staged row once they all exist (see "Manager-by-code
  linking" below).

## Idempotency — two layers, the same "no single layer trusted alone" posture

1. **Control-plane**: the `ImportBatch.status` guard above. Committing an
   already-`COMMITTED`/`COMMITTING` batch again is a `409`, not a re-run —
   this alone is what the required "re-running the same import batch does
   not duplicate" test proves directly.
2. **Data-plane**: every importer resolves its target row by NATURAL KEY
   first, then creates or updates — never a blind create:
   - EMPLOYEE: `(tenantId, employeeCode)` — the SAME `@@unique` the real
     employee create already enforces.
   - BRANCH: `(tenantId, name)`. DEPARTMENT: `(tenantId, branchId, name)`.
     DESIGNATION: `(tenantId, name)`. COST_CENTER: `(tenantId, code)`.
   - LEAVE_BALANCE: `(tenantId, employeeId, leaveType, periodYear)` — via
     `LeaveBalanceService.getOrCreateBalance` itself.

   This is what makes importing the SAME file twice, as a brand-new batch
   (the realistic "client fixed a few rows and re-uploaded the whole
   file" scenario), safe too — not just literally re-committing one batch
   id. **Honest exception**: `ATTENDANCE_HISTORY`/`PAYSLIP_HISTORY` are
   pure append logs with no natural key of their own (see "Historical
   data" below) — re-uploading the same file as a new batch WILL append
   duplicate rows for those two entity types. Layer 1 (the status guard)
   still fully covers "committing the same batch twice"; this gap is only
   about a second, independent upload of the same source file.

## Column mapping

- `IMPORT_ENTITY_FIELDS` (`packages/shared/src/validators/migration.validator.ts`)
  is the one field catalog for every entity type — `{ key, label,
required }[]` — read by BOTH the backend (`assertColumnMappingComplete`
  rejects an incomplete mapping BEFORE any file is even parsed, so a
  client sees one clear 400 rather than hundreds of per-row failures
  caused by one missing column) and the portal/admin mapping-step UI
  (renders one row per spec, a `<select>` of the file's OWN detected
  headers). WHICH of an EMPLOYEE row's fields are ACTUALLY required beyond
  this list (country-pack-driven statutory fields — US SSN/W4 vs. QA
  QatarID/visa) is resolved by the real `EmployeeService`/Country Pack
  machinery at validate/commit time, never duplicated here — see
  [country-packs.md](./country-packs.md).
- A mapping is `{ [ourFieldKey]: "client's own column header" }`,
  snapshotted onto `ImportBatch.columnMapping` at CREATION time — even
  when sourced from a `ColumnMappingTemplate`, so a later edit/deletion of
  that template never changes an in-flight or historical batch's own
  behavior.
- `ColumnMappingTemplate` (tenant-scoped, `@@unique([tenantId, entityType, name])`)
  makes a mapping reusable across repeat imports (a monthly leave-balance
  top-up from the same HRIS export, say) — plain CRUD
  (`ColumnMappingTemplateService`), no business rules beyond that
  uniqueness.
- **Client-side header detection.** Both `apps/portal` and `apps/admin`
  read just the header row of an uploaded file BEFORE anything is sent to
  the server (`lib/migration/read-file-headers.ts`, byte-identical
  duplicates — the same "no shared React package" precedent
  `I18nProvider.tsx` already sets, see
  [i18n-timezone-rtl.md](./i18n-timezone-rtl.md)): a minimal CSV header
  split for `.csv`, and the SheetJS `xlsx` library (also added to both
  frontend apps, mirroring the backend's own dependency) for `.xlsx`. This
  is intentionally NOT a full RFC4180 parser — the real, authoritative
  parse of the WHOLE file happens server-side either way.

## File handling and storage

- Accepts CSV (`csv-parse`, the SAME dependency 1.1's bulk employee import
  already uses) and Excel `.xlsx` (a NEW dependency, `xlsx`/SheetJS,
  added to `apps/api`). Both formats normalize to the identical
  all-string-values row shape (`parseImportFile`,
  `apps/api/src/migration/file-parsing/parse-import-file.ts`) — every
  downstream coercion (`Number(...)`, `new Date(...)`, JSON parsing) is
  format-agnostic; XLSX cells are read with `raw: false` specifically to
  get formatted strings, never SheetJS's internal numeric/date-serial
  representation.
- Uploaded files are stored via 1.1's EXISTING `StorageService`/MinIO,
  keyed `migration/<tenantId>/<batchId>/<fileName>` — the same
  tenant/entity-partitioned bucket-layout convention `EmployeeDocument`
  already established.
- **Purge — "never store raw uploaded PII files longer than needed."**
  `MigrationPurgeService.purgeExpiredFiles()` finds every TERMINAL batch
  (`COMMITTED`/`COMMITTED_WITH_ERRORS`/`FAILED`) whose file hasn't been
  purged and whose `updatedAt` is older than `IMPORT_FILE_RETENTION_HOURS`
  (env-configurable, default **72 hours**) — the SAME cross-tenant
  discovery (owner `prisma`, cheap indexed read) / per-tenant-transaction-
  mutation (`withTenantContext`) split `WorkflowEscalationService.sweepOverdueSteps`
  (0.7) and `TicketSlaService.sweepOverdueTickets` (3.1) already establish
  for themselves. Deletes the S3/MinIO object (`StorageService.deleteObject`,
  a NEW additive method — no caller before this step ever needed to
  remove a stored object) and sets `fileStorageKey = null`/`filePurgedAt`.
  **Not wired to a real scheduler** — the SAME documented, accepted
  "manual trigger only" tradeoff 0.7/1.2/1.3/3.1 already take; exposed as
  `POST /migration/purge/run` (`migration.manage`) for now, safe to call
  repeatedly/concurrently.

## The importers

Each importer lives in `apps/api/src/migration/importers/`.

| Entity type          | Natural key                                     | Routes through                                                                                                                                         |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BRANCH`             | `(tenantId, name)`                              | Direct write (no dedicated service exists for this plain reference table)                                                                              |
| `DEPARTMENT`         | `(tenantId, branchId, name)`                    | Direct write; resolves `branchName` -> `branchId`                                                                                                      |
| `DESIGNATION`        | `(tenantId, name)`                              | Direct write                                                                                                                                           |
| `COST_CENTER`        | `(tenantId, code)`                              | Direct write                                                                                                                                           |
| `EMPLOYEE`           | `(tenantId, employeeCode)`                      | **`EmployeeService.create`/`.update`** — country-required fields, encryption, custom fields all enforced exactly as a normal `POST`/`PATCH /employees` |
| `LEAVE_BALANCE`      | `(tenantId, employeeId, leaveType, periodYear)` | **`LeaveBalanceService.getOrCreateBalance` + `setOpeningBalance`**                                                                                     |
| `ATTENDANCE_HISTORY` | none (append log)                               | Direct write into `MigratedAttendanceSummary` (a NEW, dedicated table)                                                                                 |
| `PAYSLIP_HISTORY`    | none (append log)                               | Direct write into `MigratedPayslipRecord` (a NEW, dedicated table)                                                                                     |

- **Why BRANCH/DEPARTMENT/DESIGNATION/COST_CENTER write directly.** No
  dedicated CRUD service exists anywhere in this codebase for these plain
  reference tables (they're created via seeding/direct Prisma today) —
  there is nothing to "consume" for these four, so the importer IS the
  first real write path for them. This is a narrower scope than
  EMPLOYEE/LEAVE_BALANCE, which have real business rules (country-pack
  required fields, entitlement snapshotting) that must never be
  duplicated.
- **`LeaveBalanceService.setOpeningBalance`** (additive, this step) is
  deliberately DIFFERENT from the existing `adjust()` method: a client
  migrating mid-year is handing over their CURRENT accrued/carried-over
  totals from a prior system, to be SET exactly as given — not applied as
  a delta on top of whatever this freshly-created balance row already
  holds. `LeaveModule` additively exports `LeaveBalanceService` for this
  (the SAME "consumer imports the reused module" direction 3.1's
  Expense->Payroll `ExchangeRateService` export already establishes).

### Historical data (`ATTENDANCE_HISTORY`/`PAYSLIP_HISTORY`) — deliberately scoped down and read-only

The brief explicitly calls for keeping these two "scoped" and never
recomputing historical payroll/attendance. Rather than writing into the
REAL `AttendanceDailySummary` (1.3, freely RECOMPUTED by a scheduled job —
a migrated row living there would silently vanish the first time that job
runs for the same employee/day) or a REAL `PayrollRun`/`PayrollRunLine`
(2.1, which would mean either fabricating a fake payroll run or routing
through the tax/statutory engine for numbers that are already final), both
importers write into two NEW, purpose-built, read-only tables:
`MigratedAttendanceSummary` and `MigratedPayslipRecord`. Neither table is
read by any existing report, rollup, or engine — they exist purely as a
carried-forward historical reference, clearly separate from live
computation. `MigratedPayslipRecord.grossPay`/`.netPay` are field-level
gated behind `salary.view` (the response DTO layer — not built yet in this
step's UI, tracked as a known gap below) but, unlike
`Employee.baseSalaryEncrypted`, are **not** encrypted at rest — an honest
asymmetry accepted given how explicitly scoped-down this pair is.

## Manager-by-employeeCode linking — the one cross-row case named in the brief

`EmployeeImporter.finalize` is the one importer that implements the
optional second `EntityImporter.finalize` pass, because a manager's own
row can appear LATER in the file than its reports ("resolve the manager
graph after rows are staged"):

- `processRow` never sets `managerId` at all — every employee row is
  created/updated first, exactly as if it had no manager.
- `finalize` then runs once every row in the batch has been staged (in a
  dry run: validated-not-written; in a commit: actually written), and for
  each row naming a `managerEmployeeCode`:
  - **Commit**: looks the manager up by `employeeCode` in the DB (which by
    now includes every employee this SAME batch just committed, as well
    as any pre-existing ones) and calls `EmployeeService.update(...,
{managerId})`.
  - **Dry run**: nothing was written, so "resolves" means the code
    matches either an employee already on record OR another row in THIS
    batch that would itself succeed (tracked as an in-memory set of
    staged employeeCodes) — no DB write needed to prove this.
  - An unresolvable code is recorded as a SEPARATE row error from the
    employee's own create/update outcome — the employee still exists (or
    would exist) even when only its manager link fails to resolve. A code
    equal to the employee's own is rejected outright (belt-and-braces on
    top of `EmployeeService`'s own self-manager check).

## Row-level error reporting

- `ImportRowError` is a REAL TABLE (`tenantId`, `importBatchId`, `phase:
'DRY_RUN' | 'COMMIT'`, `rowNumber`, `message`, `rowData` — the MAPPED,
  not raw, row) — deliberately not a growing JSON array column on
  `ImportBatch` (which would risk unbounded blob growth and can't be
  paginated/indexed). Re-running dry-run for the same batch DELETES its
  prior `DRY_RUN`-phase rows first, so this table never accumulates stale
  findings from a superseded pass.
- `GET /migration/batches/:id/errors` returns them as JSON;
  `GET /migration/batches/:id/report` streams a CSV whose columns are
  `rowNumber, phase, message`, followed by the entity's OWN field catalog
  (`IMPORT_ENTITY_FIELDS`) — so the client sees their own spreadsheet
  values right next to the plain-language reason, in a file they can
  open directly in the same tool they built the import from.
- `ImportBatch.mode` — `PARTIAL` (default) commits every valid row and
  reports the rest; `ALL_OR_NOTHING` refuses to commit AT ALL (nothing
  written) if the last dry run's `errorCount > 0`. This is a
  commit-START gate against the ALREADY-KNOWN dry-run error count, not
  one giant transaction wrapping every row (which would reintroduce the
  long-transaction/connection-pool-exhaustion risk 0.10 specifically
  guards against — see [resilience.md](./resilience.md)). Honest,
  documented residual: a row that passed dry-run but fails at the actual
  moment of commit (e.g. a referenced branch deleted in the interim) is
  still recorded as a normal per-row error, even in `ALL_OR_NOTHING` mode
  — it does not roll back rows that already committed in the same batch.

## BullMQ — one queue, two job names

`migration` (`MigrationProcessor extends WorkerHost`) handles both
`validate` and `commit` jobs, dispatching by `job.name` to
`MigrationProcessingService.runDryRun`/`.runCommit` — the SAME reusable
0.8 BullMQ pattern every prior module already established (see
[notifications-queues.md](./notifications-queues.md)'s doc comment on
`QueueModule`), sharing one processor class rather than two
nearly-identical ones since the two phases differ only in the `commit`
boolean threaded through `runImportRow`. Both are context-less workers —
no `TenantContextService`, `tenantId`/`batchId` arrive as explicit job
data, every DB access opens its own `withTenantContext` transaction — the
identical posture `EmployeeImportProcessor`/`LeaveAccrualProcessor`
already establish for themselves.

## Who can run it

- **Tenant self-serve**: `apps/portal`'s `/migration` (list/history),
  `/migration/new` (the upload -> map -> dry-run wizard), and
  `/migration/[id]` (dry-run/commit summary, row errors, report download) —
  gated on a NEW `PERMISSIONS.MIGRATION_MANAGE` (`'migration.manage'`),
  granted to `TENANT_ADMIN` (via `ALL_PERMISSIONS`) and explicitly to
  `HR_MANAGER` — setup/onboarding territory that HR genuinely owns in
  practice, the same reasoning `COUNTRY_PACK_OVERRIDE_MANAGE`/
  `CUSTOM_FIELD_MANAGE` already document for themselves — deliberately
  NOT `MANAGER`/`EMPLOYEE`.
- **Vendor/platform admin on a tenant's behalf**: `apps/admin`'s new
  `/migration` page (a tenant picker, then the identical upload -> map ->
  dry-run -> commit -> report flow, one consolidated page rather than a
  multi-route wizard — this console's own "functional over fancy"
  posture). Gated on a NEW `PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE`
  (`platform/tenants/:tenantId/migration/*`, `@PlatformRoute()`), held by
  BOTH platform roles — the same non-destructive, onboarding-support risk
  tier `IMPERSONATION_START` already documents for itself (see
  [vendor-console.md](./vendor-console.md)).
- **`PlatformMigrationService` reuses `ImportBatchService` UNCHANGED**,
  opened via `withTenantContext(tenantId, tx => ...)` rather than the
  owner `prisma` client most platform services reach for — RLS still
  applies even though the actor is a platform admin (defense-in-depth,
  per this project's "no single layer of security trusted alone" posture,
  see [tenancy-rls.md](./tenancy-rls.md)), the same pattern
  `AuditRecordService.recordForTenant`/`DomainEventAuditListener` already
  establish for writing into a tenant's own tables from outside its
  request context.
- **Dual-audited**, exactly like 4.1's impersonation / 4.2/4.3's own
  platform-triggered tenant actions: every platform-initiated write
  records into BOTH the platform's own `PlatformAuditLog` AND (via the
  EXISTING `AuditRecordService.recordForTenant`, `actorPlatform: true`)
  the TARGET TENANT's own `audit_log` — a tenant's `TENANT_ADMIN` can see
  for themselves, via their own ordinary `GET /audit`, that a vendor admin
  ran an import on their behalf. `ImportBatch.initiatedByPlatformAdminId`
  (a plain id, no FK — `PlatformAdmin` is a structurally separate,
  non-tenant-scoped identity space, the same "just an id" pattern
  `impersonatedByPlatformAdminId` already uses across this exact tenant
  boundary) is set at creation, so the commit's OWN completion-summary
  audit write (from `MigrationProcessingService.runCommit`, which runs in
  a context-less worker either way) is ALREADY correctly tagged with zero
  extra code — the action's origin travels on the batch row itself.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: importing does not itself enforce per-branch data scoping on
the CALLER — every importer receives `allowedBranchIds: null`
(unrestricted) regardless of who's running it, accepted since
`migration.manage`/`TENANT_MIGRATION_MANAGE` are already
TENANT_ADMIN/HR_MANAGER/platform-admin-only, tenant-SETUP territory rather
than a routine branch-scoped HR workflow (unlike Leave/Attendance/Employee
themselves, which DO enforce it); `ATTENDANCE_HISTORY`/`PAYSLIP_HISTORY`
have no natural key (a pure append log) so a second upload of the same
source file as a brand-new batch appends duplicates — the batch-status
idempotency layer still fully covers re-committing the SAME batch; no
custom-fields support in any importer (an EMPLOYEE row's custom fields are
simply never set by this path — a real, scoped gap, not silently
dropped); `MigratedPayslipRecord.grossPay`/`.netPay` are not encrypted at
rest (unlike the real `Employee.baseSalaryEncrypted`); `apps/admin`'s
onboarding import page has no dedicated Playwright coverage this step
(the identical dry-run/commit/report code path is already proven twice —
once via the backend e2e suite's platform-admin scenario, once via the
portal's own real-browser Playwright spec); Phase 3.5's other two named
slices, benefits administration (3.5.2) and e-signatures (3.5.3), and the
deferred 3.5.4 (statutory reporting), are not built by this step.

Verified end-to-end over real HTTP by
`apps/api/test/migration.e2e-spec.ts` and, through the real browser, by
`apps/portal/tests/migration.spec.ts` — see the matching
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) entry for the full scenario list and
counts.
