# Statutory / government reporting

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.5.4 (Phase 3.5's final slice) — `packages/db`,
`packages/shared`, `apps/api/src/statutory-reporting`, `apps/portal`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "3.5.4 statutory reporting"
entry) for the full file list and verification notes.

## THE BOUNDARY

> This module GENERATES periodic government filing forms/exports FROM
> already-FINALIZED `PayrollRun` data (2.1). It never calculates a figure
> itself — CALCULATING is the resolved Country Pack + `PayrollEngineService`'s
> job (see [payroll.md](./payroll.md)/[country-packs.md](./country-packs.md)),
> completely untouched by this step. If a number in a generated report is
> wrong, the fix is a payroll/pack issue, never a change in this module.

A report is a read-only AGGREGATION: it reads `PayrollRunLine.grossPay`/
`componentBreakdown` and `Employee.statutoryFields` for runs whose
`PayrollRun.status` is `FINALIZED` or `PAID` — the SAME "only a genuinely
final run" gate `PayrollBankExportService` already enforces for bank export
(see payroll.md's bank-export section) — and re-derives nothing. A branch/
period with no finalized run throws loudly (a `FAILED` generated-report row
with a clear error message) rather than silently reporting zero employees.

## THE COMPLIANCE BOUNDARY — read this before filing anything this module generates

> This module's report STRUCTURES and generation pipeline are
> production-ready: the right per-employee fields (CNIC/NTN, gross pay, tax
> withheld, statutory contributions), the right period granularity
> (monthly/quarterly/annual), PDF + CSV output. The EXACT current form
> layout, field requirements, and submission format/channel for each filing
> — commonly changed by FBR/EOBI/provincial notifications — is **NOT**
> certified by this module and **MUST be verified against the current
> authority requirement (FBR/EOBI/the relevant provincial authority, or the
> client's own accountant) before a generated report is ever actually
> filed.** A generated report is a strong STARTING POINT, never a
> guaranteed-accepted submission.

Every `StatutoryReportDefinition` row carries its own `complianceNote`
field naming exactly this caveat for that specific report (see
`packages/db/src/seed-statutory-report-definitions.ts`) — the SAME
"VERIFY, don't guess" discipline
[pakistan-pack.md](./pakistan-pack.md) already holds every legally-sensitive
PACK figure to, extended here to FORM SPECIFICS rather than tax/statutory
NUMBERS (those numbers are the pack's own responsibility, unchanged by this
step). The note is shown on the generation UI **and printed directly on the
generated PDF itself** (`StatutoryReportPdfService`) — a downloaded/printed/
shared copy still carries the warning, not only the surrounding portal page.

## The country-extensible framework

Three pieces, mirroring the Country Pack "data catalog + pluggable code"
split this codebase already establishes for other seams (`BankExportAdapterRegistry`
being the closest precedent):

- **`StatutoryReportDefinition`** (`packages/db`) — a global, RLS-EXEMPT
  CATALOG row per (country, report code): `name`/`description`/`periodType`
  (`MONTHLY`/`QUARTERLY`/`ANNUAL`)/`outputFormats`/`complianceNote`/
  `isActive`. The SAME posture `CountryPack` already takes (see
  [country-packs.md](./country-packs.md)): no `tenant_id` column, `hrm_app`
  granted `SELECT` only, written today only via the owner/seed role
  (`packages/db/src/seed-statutory-report-definitions.ts`, called from
  `prisma/seed.ts`). `GET /statutory-reports/definitions?branchId=` resolves
  whatever rows exist for THAT branch's own resolved country — zero
  branching on country code anywhere in `apps/api/src/statutory-reporting`;
  a country with no seeded definitions (e.g. QA, in this step) simply
  resolves an EMPTY catalog, not an error — proven directly in
  `apps/api/test/statutory-reporting.e2e-spec.ts`.
- **`StatutoryReportGeneratorRegistry`** (`apps/api/src/statutory-reporting/statutory-report-generator.interface.ts`)
  — a plain `reportCode -> StatutoryReportGenerator` lookup, the SAME shape
  `BankExportAdapterRegistry` (payroll's own bank-export seam, step 3.3)
  already establishes for a near-identical "pick an implementation by a
  string key from catalog data" problem. A `StatutoryReportGenerator` reads
  strictly from finalized `PayrollRun`/`PayrollRunLine`/`Employee` data (see
  `generators/finalized-payroll-lines.util.ts`) and returns one generic
  `StatutoryReportData` shape (columns + per-employee rows + totals) that
  BOTH `StatutoryReportPdfService` and `StatutoryReportCsvService` render
  from — a generator never needs to know about PDF/CSV specifics.
- **`GeneratedReport`** (`packages/db`) — the tenant-scoped REGISTER,
  ordinary RLS. `periodKey` (`"2026-06"` monthly / `"2026-Q2"` quarterly /
  `"2026"` annual, computed by `StatutoryReportService`) is the SINGLE
  uniqueness anchor (`@@unique([tenantId, branchId, reportDefinitionId,
periodKey])`) — a deliberately SIMPLER solution than `PayrollRun`'s own
  hand-written partial unique indexes for its FINAL_SETTLEMENT seam (see
  payroll.md): a report register has no need for that table's two-run-
  types-in-one-table shape, so a single derived string sidesteps Postgres's
  "NULL is distinct" trap without hand-written SQL. Re-generating the same
  (branch, report, period) is idempotent — the SAME row is reused
  (`status` reset to `PENDING`, re-enqueued), never a duplicate.

**Adding a new country's reports is exactly**: (1) seed new
`StatutoryReportDefinition` rows for that country in
`seed-statutory-report-definitions.ts`, (2) implement one small
`StatutoryReportGenerator` per report code and register it in
`statutory-reporting.module.ts`'s factory. **Nothing else changes** — the
controller, service, queue, processor, PDF/CSV renderers, RBAC, and audit
wiring are all already country-agnostic.

## Pakistan — the first concrete country

Four report definitions, all `PK`-scoped (see
`seed-statutory-report-definitions.ts` for each one's own `complianceNote`):

- **`PK_INCOME_TAX_WITHHOLDING`** (MONTHLY) — the periodic income-tax
  withholding statement filed with FBR. Per employee: CNIC, NTN, gross pay,
  and the `income_tax`-keyed `componentBreakdown` amount off that period's
  finalized run line(s) — the SAME `income_tax` key the Pakistan pack's own
  `PROGRESSIVE_BRACKETS` tax layer already produces (see
  [pakistan-pack.md](./pakistan-pack.md)), read verbatim, never recomputed.
- **`PK_EOBI_CONTRIBUTION`** (MONTHLY) — EOBI's monthly contribution
  return: employer + employee EOBI contributions per employee, reading the
  `eobi_employee`/`eobi_employer` breakdown keys — already wage-ceiling-
  capped by the unmodified rules engine at CALCULATION time (the pack's own
  `cap`), never re-derived here.
- **`PK_PROVIDENT_FUND_CONTRIBUTION`** (MONTHLY) — an internal/trustee-
  facing report (not a direct government filing — applicability and the
  exact rate depend on the client's own PF trust deed, per
  pakistan-pack.md's own note), reading `provident_fund_employee`/
  `_employer`.
- **`PK_ANNUAL_SALARY_TAX_STATEMENT`** (ANNUAL) — the one report that
  GROUPS BY employee rather than emitting one row per run line: sums
  `grossPay`/`income_tax` across EVERY finalized month in the year (a real
  employee may have more than one finalized line in a year — twelve regular
  runs, plus a possible `FINAL_SETTLEMENT` run if they left mid-year), one
  row per employee, not one per run.

Every PK generator hard-codes the Pakistan pack's OWN `componentBreakdown`
key names (`income_tax`, `eobi_employee`, ...) — an honest, first-concrete-
country choice, the same way the Pakistan payslip template already hard-
codes those same keys (pakistan-pack.md). A future country's own generator
similarly declares whichever keys ITS pack produces; the framework itself
(register/queue/PDF/CSV/RBAC) never needs to know what those keys are.

## Generation lifecycle

`POST /statutory-reports/generate` (`branchId`/`reportCode`/`periodYear`/
`periodMonth?`/`periodQuarter?`) resolves the branch's country, looks up the
matching active `StatutoryReportDefinition`, computes `periodKey`,
upserts a `PENDING` `GeneratedReport` row, and enqueues a `STATUTORY_REPORT_QUEUE`
BullMQ job — the SAME "enqueue one job, return immediately" shape
`PayrollRunQueueService` already establishes (report generation is
explicitly "a BullMQ job for larger orgs" per this step's own brief).
`StatutoryReportProcessor` (context-less, like every other BullMQ processor
in this codebase) flips the row to `GENERATING`, resolves the branch's pack
(for `currencyCode`/`language`), calls the registered generator, renders
PDF/CSV via `StatutoryReportPdfService`/`StatutoryReportCsvService`, uploads
both to 1.1's `StorageService`/MinIO, and flips the row to `COMPLETED`
(with `summary: {employeeCount, totals}`) or `FAILED` (with `errorMessage`)
— unlike `PayrollRunProcessor`'s per-employee resumability, a whole report
is one atomic unit: there is no meaningful "half a report," so a retried job
just regenerates the whole thing safely (every write either fully replaces
the row or is a fresh idempotent storage upload keyed by the report's own
id).

## PDF / CSV rendering

`StatutoryReportPdfService` reuses the SAME `pdfkit` + bundled-DejaVu-font
approach `PayslipPdfService` (2.1) established (see payroll.md's font note
— the same Arabic/Urdu complex-text-shaping limitation applies here), laid
out as a genuine per-employee TABLE (the first PDF renderer in this
codebase to do so, since no table-layout library was available — see that
file's own doc comment) with the report's own `complianceNote` printed
directly at the bottom. RTL alignment follows the resolved pack's own
`payslipTemplate.language` via the SAME `isRtlLanguage` mechanism payslips
already use — for a PK branch this renders Urdu-appropriate right-alignment
with no new i18n code. `StatutoryReportCsvService` reuses the SAME plain,
hand-escaped CSV approach `GenericCsvBankExportAdapter` (2.1/3.3) already
establishes, suitable for uploading through an authority's own portal where
one accepts a generic CSV.

## Security, RBAC, audit

Two new permissions (`packages/shared/src/constants/permissions.ts`),
TENANT_ADMIN/HR_MANAGER only — the SAME tier `PAYSLIP_VIEW`/`SALARY_VIEW`/
`BENEFITS_MANAGE` already occupy, since a generated report carries the same
class of legally-sensitive per-employee data: `statutory_report.generate`
(trigger a new report run) vs. `statutory_report.read` (list the register,
view status, download an already-generated report) — the same generate-
vs-read split `payroll.run`/`payslip.view` already establish for an
adjacent concern. `GeneratedReportResponseDto.summary` is field-level gated
behind `salary.view` via the EXISTING `@RequiresPermission()`/
`PermissionSerializerInterceptor` mechanism (defense-in-depth for a custom
role — every default role holding `statutory_report.read` already holds
`salary.view` too). `POST /statutory-reports/generate` is `@AuditLog`'d;
`GET /statutory-reports/:id/download` deliberately is NOT — the SAME reason
`PayrollController.bankExport`/`.payslip` aren't (a `StreamableFile`
response overflows `AuditInterceptor`'s redaction walk — see payroll.md's
"a real bug caught" note). Every tenant-scoped table (`GeneratedReport`)
gets the identical `tenant_isolation` RLS policy every other table in this
schema already carries; `StatutoryReportDefinition` is RLS-exempt global
reference data, the same posture `CountryPack` takes.

## Portal UI

`/statutory-reports` (`apps/portal/src/app/(app)/statutory-reports/page.tsx`,
gated on `statutory_report.read`/`.generate`): pick a branch, see that
branch's own resolved report catalog (with each report's `complianceNote`
shown inline) and a prominent compliance banner, generate, and a history
list with status badges (`PENDING`/`GENERATING`/`COMPLETED`/`FAILED`) and
PDF/CSV download buttons once `COMPLETED`. Follows every other admin-
console page's established shape (`useAsync`, `PageSpinner`/`EmptyState`,
`Alert` for the compliance notice, a `Refresh` button for async-status
polling — the SAME shape the Payroll run detail page already uses for its
own async `workflow.approved` status flip, rather than client-side
auto-polling).

**Deliberately an admin-console-only page — no ESS variant, so no RTL
proof applies to it.** Every admin-console page in this codebase
(`/payroll`, `/benefits/admin`, ...) renders LTR regardless of the branch's
own country, per [i18n-timezone-rtl.md](./i18n-timezone-rtl.md)'s "RTL is a
session-aware ESS concern" posture — there is no employee-facing surface
for this feature an RTL test could apply to. The Pakistan pack's Urdu/RTL
rendering IS exercised, inside the DOWNLOADED PDF itself (see "PDF / CSV
rendering" above), reusing the SAME already-tested `isRtlLanguage`
mechanism payslips use — not independently re-verified by the Playwright
suite, since parsing rendered PDF byte layout for alignment is impractical
and the mechanism itself is shared, already-tested code.

## How to add another country's reports

Seed new `StatutoryReportDefinition` rows for that country (a name/
description/periodType/outputFormats/complianceNote per report) and
implement + register one `StatutoryReportGenerator` per report code in
`statutory-reporting.module.ts`. **Nothing in the controller/service/queue/
processor/PDF/CSV/RBAC framework needs to change.** Legal correctness of a
report's exact current form/field/submission requirements remains a
per-country, per-report AUTHORING responsibility — this module's job stops
at "aggregates exactly what already-finalized payroll data says, correctly
structured."

## Known, documented gaps for this phase

No scheduled/automatic report generation (e.g. "always generate last
month's PK income-tax statement on the 1st") — every report is generated
on demand via an explicit `POST /statutory-reports/generate` call; adding a
scheduled trigger would be a small additive BullMQ repeatable-job wrapper
around the EXISTING `StatutoryReportService.generate`, the same shape
`PartitionMaintenanceService`'s own `onModuleInit` repeat-job registration
already establishes, not attempted here since no report in this step's own
scope actually requires one. No electronic-filing/portal-submission
integration (a generated report is downloaded and filed manually) — a real
FBR/EOBI e-filing API integration is a documented, future adapter seam, the
same "not required by this step's own scope" posture every other honest gap
in this codebase takes. Provincial-level reporting variation (Sindh/Punjab/
KPK/Balochistan each may have their own requirements for certain filings)
is not modeled — the same scope boundary [pakistan-pack.md](./pakistan-pack.md)
already documents for the pack itself.

Verified end-to-end over real HTTP by
`apps/api/test/statutory-reporting.e2e-spec.ts` (12 tests: the report
catalog resolving generically from a branch's own country, including an
EMPTY catalog for a country with no seeded definitions; a draft/calculated-
only run correctly failing generation rather than silently reporting zero;
all four PK reports generating correct per-employee/aggregate figures from
a REAL finalized payroll run, including the annual statement's cross-month
grouping; idempotent re-generation; audit capture; deny-by-default RBAC;
cross-tenant RLS isolation) plus `apps/portal/tests/statutory-reports.spec.ts`
(3 Playwright tests proving the UI wiring — generate, poll to `COMPLETED`,
download, the compliance notice's visibility, and RBAC/nav-visibility —
since the underlying figures are already proven at the API level). Full
`apps/api` suite (541 tests) + `packages/db` suite (37 tests) run
`--runInBand`: all green, zero regressions. Full portal Playwright suite
(98 tests) green. Full-repo `pnpm build`/`pnpm lint` green across all 8
workspace tasks.
