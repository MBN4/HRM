# Payroll

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 2.1 (Phase 2's first step) — `packages/db`, `packages/shared`,
`apps/api/src/payroll`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "2.1
payroll module" entry) for the full file list and verification notes. **THE
HIGHEST-RISK MODULE in this codebase** — a wrong tax/statutory number is the
client's legal exposure, not just a bug — so this step is narrower than it
sounds:

> **THE BOUNDARY.** This module's engine computes STRICTLY what the resolved
> Country Pack (0.5) declares. It never hardcodes any country's rules, and
> pack legal correctness is a per-country AUTHORING responsibility, not an
> engine concern. If a number is wrong, the fix is a pack edit, never a code
> change here.

Proof of genericity: `PayrollEngineService.computeForEmployee` is the ONE
function that produces a correct US run (4-layer tax: federal progressive +
flat state + FICA social security capped + FICA Medicare) and a correct
Qatar run (no income tax, a tiered end-of-service gratuity) from the two
EXISTING reference packs — zero country-code branches anywhere in
`apps/api/src/payroll`. `apps/api/test/payroll.e2e-spec.ts` asserts real,
hand-computed numbers from both, not just "a response came back 200".

## Scope discipline — what this step did NOT touch

`packages/shared/src/validators/rules-engine.validator.ts` and
`apps/api/src/country-packs/rules-engine/*` (the 0.5 sandbox — `Expr`,
`evaluateExpression`, `computeMultiLayerTax`, `computeStatutoryComponents`,
`computeStatutoryComponent`) are used AS-IS, zero edits.
`packages/db/src/seed-country-packs.ts` is untouched — both reference packs
keep `payrollMode: 'CALCULATE'`; the DELEGATE-mode proof pack is created
ad-hoc by the e2e suite, the same way every other suite creates
test-specific fixtures without touching seed files. `WorkflowEngineService`,
`EmployeeService`, `AttendanceSummaryProcessor`, `LeaveBalanceService` are
all consumed, never modified. Two existing files gained ONE mechanical,
additive line each — `NotificationDispatchListener`/`DomainEventAuditListener`
each gained an `@OnEvent('payroll.*')` subscription, the same way
`licensing.*` was added when 0.6 introduced that namespace — and
`packages/shared`'s audit `REDACTED_KEY_PATTERN` gained four matched keys
(`grossPay`/`netPay`/`employerCost`/`componentBreakdown`).

## Variable semantics — the engine's own necessary decisions

The Country Pack schema only NAMES `basicSalary`/`grossSalary`/
`monthlySalary`/`annualSalary`/`yearsOfService` (0.5's `ALLOWED_EXPR_VARIABLES`)
— it doesn't define what they mean for a periodic payroll run. This module
is the first real consumer, so it has to decide, ONCE, the same way for
every country (`apps/api/src/payroll/payroll-variables.util.ts`):

- **`basicSalary`** — the employee's CONTRACTUAL monthly base pay, decrypted
  from `Employee.baseSalaryEncrypted` (1.1) — never adjusted for attendance.
  Used by components/statutory rules that key off contractual base (e.g.
  Qatar's gratuity).
- **`grossSalary` / `monthlySalary`** — DELIBERATELY the SAME figure: this
  period's ACTUAL computed gross (basic, pro-rated for unpaid-leave days,
  plus active salary-structure components, plus overtime pay). Packs may
  use either name.
- **`annualSalary`** — `monthlySalary * 12`, an ANNUALIZED PROJECTION of
  this period's gross. A documented simplification: no year-to-date
  reconciliation across a mid-year raise (same "documented, not silently
  accepted" posture as leave.md's carry-over placeholder).
- **`yearsOfService`** — `(asOfDate - Employee.joinDate)` in fractional
  years, computed at TWO different `asOfDate`s per run (see the gratuity
  note below).

Payroll period = one calendar month (`periodYear`/`periodMonth`), matching
1.2's leave-accrual and 1.3's attendance-summary cadence exactly.

### ANNUALIZE → COMPUTE → DE-ANNUALIZE — a real correctness pitfall, caught

`computeMultiLayerTax`/`computeStatutoryComponent` compute against WHATEVER
base a layer/component declares. The US pack's four tax layers all declare
`base: 'annualSalary'` — so `computeTaxLayer` returns each layer's ANNUAL
liability on the annualized figure. Naively subtracting that from ONE
month's gross would deduct roughly twelve months of tax from a single
paycheck. The fix (`PayrollEngineService`, `periodDivisorForTaxLayer`/
`periodDivisorForStatutoryComponent`): divide a layer/component's result by
12 IF AND ONLY IF its own declared `base` is `annualSalary` — a
`grossSalary`/`monthlySalary`/`basicSalary`-based layer needs no
adjustment, and a `FORMULA` layer/component (no explicit `.base` field) is
taken as-is, its author's own responsibility for what period it represents.
This is the standard "annualize a periodic run against an annual bracket
table, then de-annualize the result" technique real payroll withholding
tables use — not a hack.

### The tiered-gratuity double-counting trap — also caught

`computeStatutoryComponent`'s `TIERED_BY_YEARS_OF_SERVICE` kind (Qatar's
end-of-service gratuity) returns a CUMULATIVE total earned over the WHOLE
tenure to date — that is what the function is defined to compute (0.5,
unmodified). Using that cumulative figure directly as one month's employer
cost would double-count every month forever (a 3-year employee's gratuity
liability would be added to EVERY SINGLE monthly run). The correct period
amount is the INCREMENTAL delta: `computeStatutoryComponent` is called
TWICE — once with `yearsOfService` as of the period's end, once as of its
start — and the period's employer cost is `(cumulative at end) - (cumulative
at start)`, never a second implementation of the tiering math. Verified
directly in `payroll.e2e-spec.ts`: the QA test asserts the reported gratuity
is a small monthly accrual (tens to low hundreds of QAR), explicitly
bounded well below the ~18,900 QAR CUMULATIVE 3-year total the bug would
have produced — a real regression proof, not just a happy-path number.

## Salary structure — a NEW payroll-owned concept, not a CountryPack field

The task (and this step) explicitly keeps `PayrollComponentDefinition`
(`packages/db`) OUT of `CountryPackConfig` — that schema/validator file is
off-limits to this step, and mandatory tax/statutory deductions must stay
the single source of truth from the pack. `PayrollComponentDefinition`
covers only EARNING/ALLOWANCE/discretionary-DEDUCTION line items
(tenant-scoped, per country), each `FIXED_AMOUNT` / `PERCENTAGE_OF_BASE` /
`FORMULA` — `FORMULA` reuses 0.5's `Expr`/`evaluateExpression` AS-IS
(imported, not redefined — the same "reuse the whitelist itself" posture
0.7's workflow condition evaluator already documents for its own AST).

**A component is computed BEFORE gross pay exists** — it's an INPUT to
gross, not derived from it — so it may only reference values already known
at that point: `basicSalary`/`yearsOfService`. `percentageOfBase` is
narrowed at the SCHEMA level to the literal `'basicSalary'` (not the full
`SALARY_BASES` union); a `FORMULA` component is checked at WRITE time
(`PayrollComponentDefinitionService.upsert`,
`assertFormulaUsesOnlyPreGrossVariables` — a static walk over the already-
validated `Expr` tree, not a second evaluator) and rejected loudly if it
references `grossSalary`/`monthlySalary`/`annualSalary`.

## CALCULATE vs. DELEGATE

`PayrollRun.payrollMode` is SNAPSHOTTED from the resolved pack at run
CREATION time — a later pack edit never changes how an in-flight or
historical run was actually processed.

- **CALCULATE** — `PayrollEngineService.computeForEmployee`: decrypts
  `basicSalary` (1.1 `EncryptionService`), sums active
  `PayrollComponentDefinition` rows, adds overtime pay (from 1.3's
  `AttendanceDailySummary.overtimeMinutes`, priced via the pack's own
  `workingTime.standardWeeklyHours`/`overtimeRules.multiplier`) and
  subtracts an unpaid-leave deduction (see below), then runs the resolved
  `tax.layers`/`statutory.components` through the unmodified 0.5 functions.
- **DELEGATE** — `PAYROLL_PROVIDER_ADAPTER` (DI token) +
  `PayrollProviderAdapter` interface, the SAME "swap one binding, no caller
  changes" seam as 0.4's `AUTH_PROVIDER`/0.8's per-channel notification
  providers/1.3's `BIOMETRIC_DEVICE_ADAPTER`. `StubPayrollProviderAdapter`
  (bound today) is a dev/reference implementation only — gross = net =
  basic salary, no tax/statutory math at all, tagged `computedVia:
'DELEGATE'` so tests can assert this path — never `PayrollEngineService`
  — is what ran for such a run. A real external-payroll-provider
  integration implements this interface and changes only the DI binding.

## "Unpaid leave" and overtime — reusing existing data, not inventing new

**"Unpaid leave" = `AttendanceDailySummary.status === 'ABSENT'` days within
the period** (1.3 already computes exactly this per employee/day) — reused
directly rather than inventing a new concept Leave (1.2) has no notion of
(its `LeaveType` enum is closed, every leave type is a paid entitlement).
The daily rate is `basicSalary / countBusinessDays(period)` — `leave-day-
calculator.ts`'s EXISTING `countBusinessDays` (1.2) is imported directly,
not reimplemented, driven by the same resolved pack's weekend/holiday data.
Overtime pay sums `AttendanceDailySummary.overtimeMinutes` over the period
and prices it via an hourly rate derived from the pack's own
`workingTime.standardWeeklyHours`, times `overtimeRules.multiplier` —
already-resolved pack data, no new pack fields needed.

## Money and multi-currency

Every monetary column is Postgres `Decimal` (Prisma `Decimal`/`@db.Decimal`)
— NEVER a float. The 0.5 rules engine itself still computes in plain JS
numbers internally (unmodified, as required — its own `round2` already
rounds every layer/component result to 2dp before returning); the payroll
engine converts those results to `Decimal` immediately at the boundary, and
every SUM (a run's totals, the currency rollup) is `Prisma.Decimal`
arithmetic, so aggregation error can never compound across many employees.

`Tenant.baseCurrencyCode` (new, small, additive column — same "seam
column" pattern as `Branch.geofenceLat`/`Employee.terminatedAt`, defaults
`"USD"`) is the tenant's reporting currency. `ExchangeRate` is a NEW global,
RLS-exempt reference table (same posture as `CountryPack` — objective
market data, not tenant-owned; `hrm_app` gets `SELECT` only, owner-role/
seed-writable today). `ExchangeRateService.getRate` resolves the latest
rate `asOfDate <=` the requested date and throws loudly (404) if none
exists — the SAME "no `missing_ok`" posture Country Pack resolution already
holds itself to; a genuinely missing rate must never silently resolve to a
1:1 fallback that would misreport a real rollup. `MultiCurrencyRollupService`
resolves and SNAPSHOTS the rate + converted totals onto the run once, at
calculation time — never re-resolved later, so a later rate update never
retroactively rewrites a past run's reported totals (same "snapshot, don't
re-derive" posture `LeaveBalance.entitledDays` already takes). This
resolution is UNCONDITIONAL — it runs for DELEGATE-mode runs too, so even a
fictitious/test currency needs a seeded rate into the tenant's base
currency (a real, if slightly surprising, requirement surfaced by this
step's own e2e suite).

## Idempotency and resumability

`PayrollRunLine`'s own `@@unique([tenantId, payrollRunId, employeeId])` is
the DB-level backstop. The task's own wording asks for one "on (tenant,
branch, period, employee)" — since `PayrollRun` already carries
`@@unique([tenantId, branchId, periodYear, periodMonth])`, a line's
`(tenantId, payrollRunId, employeeId)` uniqueness transitively provides
EXACTLY that guarantee one level down; this is a deliberate equivalence,
not a literal 4-column repeat.

Two independent layers guard against double-processing an employee (this
project's "no single layer trusted alone" posture):

1. `IdempotencyService.execute('payroll-run', '<tenantId>:<runId>:
<employeeId>', fn)` (0.10, Redis) — the primitive explicitly earmarked for
   payroll since it was built. **A per-employee failure is left to THROW
   out of `fn()`**, deliberately — `IdempotencyService` DELETES the Redis
   key on a thrown error rather than caching a failure as a success, which
   is exactly what lets a LATER `calculate` call actually retry that
   employee. The `FAILED` `PayrollRunLine` row itself is written in a
   `catch` OUTSIDE the idempotency wrapper, in its own fresh transaction —
   an earlier draft of this mistakenly caught the error INSIDE `fn()` before
   writing the FAILED row, which made `IdempotencyService` treat the
   (swallowed) failure as a completed success and permanently skip retrying
   that employee; worth calling out since it's an easy mistake to
   reintroduce.
2. `PayrollRunLine`'s unique constraint — `P2002` on a concurrent
   create/upsert race is treated as "already done", the same
   `LeaveAccrualRun` backstop pattern.

**Resumability** (`PayrollRunProcessor.process`): fetches the run's branch's
`ACTIVE` employees and the set already `COMPUTED` for this run in ONE short
bootstrap transaction, THEN loops over employees OUTSIDE any held-open
transaction (each employee opens its OWN short transaction via the
idempotency wrapper) — the SAME shape `LeaveAccrualProcessor.process`
already establishes, deliberately NOT one transaction held open for the
whole branch-wide loop (that would violate 0.10's "no long-held
transactions" posture and could exhaust the bounded connection pool the
moment a per-employee nested transaction tried to check out a second
connection). An employee already `COMPUTED` is skipped entirely on a
re-run — a plain query against this table's own `status` column, no
separate checkpoint table. The run's totals are RECOMPUTED FROM SCRATCH
every time (`SUM` over all currently-`COMPUTED` lines), never incrementally
added — so totals are correct regardless of how many partial runs it took
to get there. The run only flips to `CALCULATED` once EVERY line for the
branch is `COMPUTED` — a run with any `FAILED`/`PENDING` line stays exactly
where it was, a deliberate control point (you should not be able to submit
a partially-failed run for approval).

## Run lifecycle + workflow approval

`DRAFT` → (`calculate`, queued) → `CALCULATED` → (`submitForApproval`, a
REAL 0.7 `WorkflowInstance`, `entityType: 'PayrollRun'` — THE RULE, zero
bespoke approval logic, the identical shape `LeaveService.submit`/
`AttendanceRegularizationService.submit` already establish) → on
`workflow.approved`, `PayrollWorkflowEventsListener` (fire-and-forget, own
`withTenantContext` transaction, the same shape `LeaveWorkflowEventsListener`
already documents for itself) flips the run to `APPROVED` — and ONLY that
transition; nothing here auto-finalizes. `finalize`/`markPaid` remain
SEPARATE, deliberate `payroll.approve`-gated actions
(`PayrollRunService.finalize`/`markPaid`) — real control points a real
payroll process needs distinct from "a human approved the numbers":
finalize locks the run as ready for payment; mark-paid records that the
transfer actually happened. There is deliberately no template-authoring
endpoint for `PayrollRun` approval either — same as every other
workflow-driven module, a template/step is created directly via the owner
`prisma` client (fixtures/tests), not a dedicated admin route.

"Run approved" notifications arrive FOR FREE — `workflow.approved` is
already a mapped `NotificationEventType` (0.8) that notifies the instance's
requester; zero new code needed. The one genuinely NEW event this step
adds is `payroll.payslip_ready` (`NOTIFICATION_EVENT_TYPES`/
`DEFAULT_NOTIFICATION_CHANNELS`, `packages/shared`), emitted by
`PayslipService.generate` with the employee's linked `User.id` directly in
the payload (no recipient-resolution query needed, same pattern
`auth.password_reset_requested` already uses) — picked up by the EXISTING
notification hub with zero new dispatch code.

## Payslips

`PayslipPdfService` renders one PDF per `PayrollRunLine` from the resolved
pack's OWN `payslipTemplate` (`language` + ordered `lineItems` — already-
existing 0.5 pack data; nothing new added to that schema), mapping
`componentBreakdown` entries to the template's line-item labels by `key`.
No PDF-generation skill was actually available in this environment
(confirmed absent from the skill listing) — `pdfkit` (pure-JS, no native
deps) is the pragmatic choice, a new `apps/api` dependency.

**Font note, an honest limitation.** `pdfkit`'s built-in fonts have no
Arabic glyph coverage at all — needed for the Qatar reference pack's
`payslipTemplate` (`language: 'ar'`). `apps/api/assets/fonts/DejaVuSans(-Bold).ttf`
are bundled directly in the repo (Bitstream Vera License, explicitly
permissive of redistribution as part of a larger software package) rather
than relying on the deployment environment having a system font installed
— portable to any Docker base image, including minimal ones with none.
`pdfkit` has no complex-text-layout engine, so Arabic renders as individual
glyphs, not contextually-joined cursive script — a documented, accepted
gap for this reference implementation, not silently papered over.

Stored via 1.1's `StorageService`/MinIO (`PayslipDocument`, metadata in
Postgres, bytes in object storage — same pattern `EmployeeDocument`
established), generated LAZILY on first download and cached thereafter
(`PayslipService.getStorageKey`). Field/RBAC gated: `GET /payroll/runs/:id/
payslips/:employeeId` requires `employee.read` plus either `payslip.view`
(view anyone's) or being the employee's own linked user — the same "your
own data is never out of scope" posture 1.1/1.2/1.3 already take for
self-service routes.

## Bank payment file export — one reference format, an honest gap

`BANK_EXPORT_ADAPTER` (DI token) + `BankExportAdapter` interface, the same
seam shape as every other adapter in this codebase.
`GenericCsvBankExportAdapter` (bound today) is the ONE concrete reference
format — a plain CSV (employee code/name/bank name/account number/amount/
currency). **Not built**: a real country-specific format (NACHA, SEPA, ...)
selected per pack. The task's own test list never asks for per-country
format selection, and adding one would mean either extending 0.5's
`CountryPackConfig` (explicitly off-limits) or inventing a whole new
payroll-owned "which format does this country use" table with no test
coverage driving its shape — both deferred as a documented, deliberate gap
rather than guessed at. Extending this is the same one-DI-binding swap
every other seam in this codebase already documents. Requires the run to
already be `FINALIZED`/`PAID` — a control point: you don't hand a bank a
payment file for a run still under approval. Bank details are decrypted
(1.1 `EncryptionService`) by `PayrollBankExportService` before reaching the
adapter, so adapter implementations stay pure formatting logic with no
DB/crypto dependency of their own. Deliberately NOT `@AuditLog`'d — see the
next section.

## A real bug caught during this step, worth recording

`POST /payroll/runs/:id/bank-export` originally carried `@AuditLog`/
`AuditInterceptor` like every other mutating route. `AuditInterceptor`
captures whatever the handler RETURNS as the audit row's `after` value —
and this route returns a `StreamableFile` wrapping a live Node `Readable`
stream. Redacting/serializing that generically (`redactSensitiveFields`
walking every enumerable property recursively) hit the stream's own deeply
self-referential internal structure and overflowed the call stack on every
request — surfacing in the e2e suite as one test timing out (BullMQ
silently retrying a crashing job) and, once that route was hit directly, a
clean 500. The fix — and the general lesson for any future binary/streamed
response route — is `EmployeeDocumentsController.download`'s OWN existing
precedent: a `StreamableFile`-returning route must never carry
`AuditInterceptor`. The durable record of the action is the DB row the
service itself creates (`PayrollBankExport`, `EmployeeDocument`), not a
generic HTTP-mutation audit entry.

## Security, RBAC, feature flag

Every route requires BOTH `FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL` (already
seeded, ENTERPRISE-only, since 0.6 — clearly seeded in anticipation of
this exact module, reused rather than inventing a new flag) and a
permission — the same two-decorator shape 0.6/0.4 already establish
together. `PERMISSIONS.PAYROLL_RUN`/`SALARY_VIEW` already existed (seeded
since 0.4, also clearly anticipatory). Two new permissions:
`PAYROLL_APPROVE` (`TENANT_ADMIN` only — the same "ownership/security
territory, not HR policy" reasoning `audit.read`/`license.manage` already
document, since approval is the module's financial control point) and
`PAYSLIP_VIEW` (`TENANT_ADMIN` + `HR_MANAGER`). Salary amounts
(`PayrollRun.totalGross`/`totalNet`/`totalEmployerCost`/`*Base`,
`PayrollRunLine.grossPay`/`netPay`/`employerCost`/`componentBreakdown`) are
field-level gated behind `salary.view` via `@RequiresPermission()`/
`PermissionSerializerInterceptor` — the EXACT existing mechanism
`EmployeeResponseDto.compensation` already uses, no new pattern. Every
mutating JSON-returning route is `@AuditLog`'d (amounts flow through the
existing redaction pattern, extended by this step — see above).

## How to add a new country

Author a `CountryPack` with real `tax.layers`/`statutory.components`/
`payrollMode`/`payslipTemplate` (validated against `countryPackConfigSchema`,
the exact process `seed-country-packs.ts` already documents for itself) and
bind it to a branch via that branch's `countryCode` — resolution, the
engine, DELEGATE routing, payslip rendering, and bank export all pick it up
automatically. **Nothing in `apps/api/src/payroll` needs to change.** Legal
correctness of the authored pack is the authoring party's responsibility —
this module's job stops at "computes exactly what the data says."

## Known, documented gaps for this phase

Bank export has one reference format only (see above); no per-country
selection. No YTD tax reconciliation across a mid-year pay change (the
`annualSalary` projection is always `thisMonth * 12`). Payslip PDFs render
Arabic without contextual glyph shaping (see the font note). Overtime/
unpaid-leave only reuse 1.3's already-computed `AttendanceDailySummary` —
a raw `AttendanceRecord` scan is never performed, consistent with 1.3's own
"heavy reads never hit the primary" posture, but also means payroll
inherits any of that summary's own documented simplifications (e.g. the
weekly-overtime-threshold gap noted in attendance.md).

Verified end-to-end over real HTTP by `apps/api/test/payroll.e2e-spec.ts`
(8 tests: the SAME engine computing a correct US run — federal progressive
brackets + flat state + FICA social security capped + FICA Medicare, with
overtime pay and an unpaid-leave deduction both measurably changing gross
pay versus a control employee with neither — and a correct Qatar run —
zero income tax, a correctly period-scoped gratuity accrual explicitly
bounded far below the cumulative-total bug it guards against; a
DELEGATE-mode pack routing every line to the stub adapter,
`PayrollEngineService` never invoked; idempotency — a re-run of an
already-`CALCULATED` run reprocesses nothing, `computedAt` timestamps and
totals stable; resumability — one deliberately-broken employee (a
corrupted encrypted salary value) is marked `FAILED` without blocking or
reprocessing the rest of the run, then correctly retried alone after being
fixed; a run flowing through the real 0.7 workflow to `APPROVED`, then
`finalize`/bank-export/payslip generation in both languages, with
someone-else's-payslip correctly forbidden without `payslip.view`;
`salary.view` field omission on both the run and every line; cross-tenant
isolation via RLS) plus `payroll-variables.util.spec.ts` (5 pure-function
unit tests: years-of-service fractional/clamped computation, period
start/end date UTC correctness, the `grossSalary`/`monthlySalary`-alias/
`annualSalary`-projection variable contract).
