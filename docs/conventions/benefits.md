# Benefits administration

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.5.2 — `packages/db`, `packages/shared`,
`apps/api/src/benefits`, `apps/portal`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)
(the "3.5.2 benefits administration" entry) for the full file list and
verification notes. A THIN module, the same posture 3.1's four operations
modules already establish: a consumer of systems that already exist — the
workflow engine (0.7), country packs + the rules engine (0.5), payroll
(2.1), employee dependents (1.1), RBAC (0.4), audit (0.9) — none of which
needed to change for this module to exist, beyond one additive step inside
`PayrollRunProcessor` (see "The payroll-input hand-off" below).

## THE BOUNDARY

> This module NEVER computes pay. A benefit plan's cost structure and a
> country-pack statutory scheme both only ever produce PAYROLL INPUTS —
> employee-side deductions, employer-side contributions — merged onto a
> real payroll run by `PayrollRunProcessor`, never by this module calling
> into Payroll itself. Exactly `payroll.md`'s own boundary statement,
> restated for a second module.

## Plan configuration — mirrors `PayrollComponentDefinition`, field-for-field

`BenefitPlan` (`packages/db`) is tenant-configurable DATA: `benefitType`
(`HEALTH_INSURANCE`/`PROVIDENT_FUND`/`PENSION`/`LIFE_INSURANCE`/
`BONUS_INCENTIVE`/`ALLOWANCE`/`OTHER`), `costBasis`
(`FIXED_AMOUNT`/`PERCENTAGE_OF_BASE`/`FORMULA` — the SAME three-value shape
`PayrollComponentCalcKind` already established for salary-structure
components), `fixedAmount`/`percentageOfBase`/`percentageRate`/`formula`
computing ONE total period cost. `formula` reuses 0.5's closed `Expr` AST
AS-IS (`packages/shared/src/validators/benefits.validator.ts` imports
`exprSchema` from `rules-engine.validator.ts`, never redefining it) — the
same "reuse the whitelist itself" posture every other formula-bearing
schema in this codebase already takes.

**One cost structure, one split — not two independently-configured
amounts.** `employeeSharePercent`/`employerSharePercent` (fractions summing
to 1.0, enforced by `createBenefitPlanSchema`'s `.refine()`) split the
plan's ONE computed total cost between the employee deduction and the
employer contribution, rather than letting the two drift apart via
separately-authored numbers. A `hasTiers` plan is the one exception:
`BenefitPlanTier` rows (e.g. `EMPLOYEE_ONLY` vs. `EMPLOYEE_FAMILY`) each
carry their OWN explicit `employeeAmount`/`employerAmount`, bypassing the
share split entirely — a tier already states both sides, and this phase
deliberately doesn't support percentage/formula-priced tiers (a documented
scope line, not an oversight).

**A benefit contribution is computed AFTER gross pay exists — unlike a
salary-structure `PayrollComponentDefinition`.** `PayrollComponentDefinition`
is computed BEFORE gross pay (an input to it), so its own `FORMULA`/
`percentageOfBase` are narrowed to `basicSalary`/`yearsOfService` only (see
[payroll.md](./payroll.md)). A benefit contribution runs in
`PayrollRunProcessor` AFTER the engine/DELEGATE adapter has already
returned `grossPay`/`netPay`/`employerCost` for the period, so
`percentageOfBase`/`formula` here may reference the FULL `SALARY_BASES`/
`ALLOWED_EXPR_VARIABLES` set (`grossSalary`/`monthlySalary`/`annualSalary`/
`basicSalary`/`yearsOfService`) — exactly like a CountryPack
`statutory.component` can.

`allowSelfElection` gates whether an EMPLOYEE (not `benefits.manage`) may
enroll themselves at all; `requiresApproval` routes enrollment through the
real workflow engine (see below); `affectsPayroll` (default `true`) is the
"purely informational perk" escape hatch — a plan with this `false` (e.g.
an office gym pass) is filtered out of `resolveActiveBenefitContributions`
entirely and can never reach a payroll run.

**A real, previously-flagged gap closed by this step.** The Qatar
reference pack's own doc comment since 0.5 explicitly said its GRSIA
pension scheme was "deliberately out of scope." This step adds it for
real as two asymmetric `PERCENTAGE` statutory components (`grsia_pension_employee`
5%, `grsia_pension_employer` 10%, both `base: 'basicSalary'`) — a single
`appliesTo: 'BOTH'` component can't express an asymmetric rate, so two
components are used instead of one, the same way a real scheme's two sides
usually do differ. The US reference pack gains its own FIRST employee-side
statutory withholding outside `tax.layers` (`state_disability_insurance`,
illustrative, `PERCENTAGE`/`annualSalary`/capped) — previously its only
statutory component (`futa`) was employer-only. Both additions required
updating pre-existing hardcoded net-pay/statutory-component-list
assertions in `payroll.e2e-spec.ts`, `country-packs.e2e-spec.ts`,
`operations-modules.e2e-spec.ts`, `recruitment-lifecycle.e2e-spec.ts`, and
`statutory-calculator.spec.ts` — a real, foreseeable ripple effect of
extending shared reference-pack fixtures (all now green with the updated
numbers, see the BUILD_LOG entry).

## Statutory schemes — no new payroll wiring needed at all

This is the one place this step could have gone wrong by DUPLICATING
existing behavior instead of reusing it. `PayrollEngineService` (2.1)
ALREADY applies every resolved CountryPack `statutory.components` entry
generically — `EMPLOYEE`/`EMPLOYER`/`BOTH`, `PERCENTAGE`/
`TIERED_BY_YEARS_OF_SERVICE`/`FORMULA` — through the unmodified
`computeStatutoryComponent` (0.5). Adding EOBI/GRSIA/SDI-style entries to a
resolved pack therefore ALREADY reaches a real payroll run's `netPay`/
`employerCost` with ZERO code change anywhere in this step — "same engine,
different country" for statutory schemes was true before this step ever
started; this step's own job is narrower:

- `BenefitsStatutoryService.listForBranch` — a READ-ONLY admin-visibility
  surface (`GET /benefits/statutory?branchId=`) calling Payroll's OWN
  `resolvePayrollPackConfig` (a free function, imported directly — no new
  resolution path, no `CountryPackResolutionService` duplication) to show
  which statutory schemes apply to a branch's country. It never computes
  an amount — that stays exclusively `PayrollEngineService`'s job.
- A THIRD, ad-hoc "Pakistan" `CountryPack` (EOBI-style, asymmetric 1%
  employee / 5% employer, `PERCENTAGE`/`basicSalary`) proves the
  divergence claim generically without touching either shipped reference
  pack — created directly by `benefits.e2e-spec.ts`, never added to
  `seed-country-packs.ts`, the SAME "test-specific fixture" precedent
  `payroll.e2e-spec.ts`'s own DELEGATE-mode pack already established.

**Compliance boundary — same as payroll.md's own.** Legal correctness of a
country's statutory schemes (rates, which employees a scheme actually
applies to, ...) is a per-country PACK-AUTHORING responsibility, never an
engine or this module's concern — the US/QA additions above are
illustrative/simplified for demonstration, explicitly not certified
guidance, exactly like every other number in the two reference packs.

## Enrollment — admin-assigned or ESS self-elected, optional workflow approval

`BenefitEnrollmentService.enroll` resolves the target employee the SAME
self-service-vs-`benefits.manage` shape `ExpenseClaimService.resolveTargetEmployee`
already establishes (self by default; an explicit `employeeId` needs
`benefits.manage`, branch-scoped). A `hasTiers` plan requires a
`coverageTierId` belonging to that plan; `dependentIds` must each already
exist on that employee's own `EmployeeDependent` rows (1.1) — this module
adds NO dependent CRUD of its own, it only LINKS to what already exists
via `BenefitEnrollmentDependent`.

`plan.requiresApproval` decides the enrollment's starting `status`:
`PENDING_APPROVAL` (a REAL 0.7 `WorkflowInstance`, `entityType:
"BENEFIT_ENROLLMENT"` — THE RULE, this module owns zero bespoke
approve/reject logic) or `ACTIVE` immediately for every other plan.
`BenefitsWorkflowEventsListener` mirrors `ExpenseWorkflowEventsListener`
exactly: `workflow.approved` → `ACTIVE`, `workflow.rejected` → `CANCELLED`,
nothing else. A `PENDING_APPROVAL` enrollment contributes NOTHING to
payroll until it flips `ACTIVE` — proven directly in
`benefits.e2e-spec.ts` by running a real payroll period against a still-
pending enrollment and asserting zero effect, then approving and running a
SECOND period to see it apply.

`cancel` flips `status` to `CANCELLED` and defaults `effectiveTo` to today
if unset — a cancelled enrollment stops contributing to any period whose
`periodEnd` falls after that date (see the payroll-input hand-off below).

## The payroll-input hand-off — orchestration only, the engine untouched

Mirrors the 3.1 expense-reimbursement hand-off's shape exactly (see
[operations-modules.md](./operations-modules.md)), with one structural
difference: reimbursements are read directly off `ExpenseClaim` rows with
no DI at all; benefits reuse the SAME "consumer imports the reused pure
function across a module boundary" pattern `countBusinessDays`/
`computeStatutoryComponent`/`evaluateExpression` already establish for
themselves. `apps/api/src/benefits/benefits-payroll-input.util.ts` exports
two DI-free functions:

- `computeBenefitContributionAmount(plan, tier, variables)` — the pure
  cost-then-split (or tier-lookup) computation described above.
- `resolveActiveBenefitContributions(tx, tenantId, employee, periodStart,
periodEnd, variables)` — every enrollment `ACTIVE` for at least part of
  the period, on a plan that's both `isActive` and `affectsPayroll`.

`PayrollRunProcessor.processEmployee` (`apps/api/src/payroll/runs/payroll-run.processor.ts`)
gained one additive step, `mergeBenefitContributions`, called RIGHT AFTER
the engine/DELEGATE adapter returns its result and BEFORE the existing
`mergeReimbursements` step (a benefit contribution is computed against
GROSS pay, the same timing a statutory component uses; a reimbursement is
explicitly documented as a straight net-pay add-on, the LAST step) — it
decrypts `basicSalary` (the SAME `EncryptionService` the engine itself
uses, now also injected into the processor) and reuses `buildPayrollVariables`/
`computeYearsOfService`/`periodStartDate`/`periodEndDate` (Payroll's OWN
free functions, imported directly) to build the identical variable shape
the engine itself would. Every nonzero employee amount subtracts from
`netPay` and appends a `DEDUCTION`-type `componentBreakdown` line
(`benefit_<planId>_employee`); every nonzero employer amount adds to
`employerCost` and appends an `EMPLOYER_COST`-type line
(`benefit_<planId>_employer`) — the SAME two-sided shape a statutory
component's own breakdown already takes.

**`BenefitContributionRecord`** is the payroll-input PROOF row, written
once the employee's `PayrollRunLine` id is known — `@@unique([tenantId,
enrollmentId, periodYear, periodMonth])` is this module's OWN idempotency
backstop (the same role `ExpenseClaim.reimbursementPayrollRunLineId` plays
for a one-time claim, expressed per-PERIOD here since an enrollment
recurs every period rather than being consumed once). `PayrollEngineService`
itself is never imported by, or aware of, anything in `apps/api/src/benefits`.

## Cost reporting — reads already-computed data, never a second aggregation

`BenefitsCostReportService.generate` (branch + period scoped) sums
`BenefitContributionRecord` rows for plan-based totals, and separately
reads back `PayrollRunLine.componentBreakdown` entries already tagged
`EMPLOYEE_STATUTORY`/`EMPLOYER_COST` by the unmodified engine for statutory
totals — filtering OUT any `benefit_*`-keyed line (this module's own
breakdown entries, also tagged `EMPLOYER_COST`), which would otherwise
double-count the plan-based employer totals already summed from
`BenefitContributionRecord`. This is a LIVE query, not a precomputed
rollup table — one branch's headcount for one period is a bounded, cheap
read, the same "no rollup needed yet" scope call 3.1's own cost-reporting
surfaces already make for themselves (contrast with 1.5's genuinely
tenant-wide, continuously-queried analytics dashboard, which DOES need
one).

## Security, RBAC, field-level gating

Three new permissions, the SAME read/self-service/manage split
`EXPENSE_READ`/`EXPENSE_WRITE`/`EXPENSE_MANAGE` already establish:
`benefits.read` (view plans + your own enrollments — seeded onto every
role including `EMPLOYEE`), `benefits.enroll` (self-elect a
self-election-enabled plan, cancel your own enrollment — also seeded
broadly), `benefits.manage` (define plans, enroll/unenroll ANY employee,
branch-scoped cost reporting — `TENANT_ADMIN`/`HR_MANAGER` only).
Cost-report amounts (`BenefitCostReportPlanLineDto`/
`BenefitCostReportStatutoryLineDto`) are field-level gated behind
`salary.view` via the EXISTING `@RequiresPermission()`/
`PermissionSerializerInterceptor` mechanism — no new pattern.
`GET /benefits/my-benefits` (an employee's own enrollments) is
deliberately returned as PLAIN, ungated data — "your own data is never
out of scope," the same posture every other self-service route in this
codebase already takes. Every tenant-scoped table gets the identical
`tenant_isolation` RLS policy every other table in this schema already
carries — no exceptions.

## Portal UI

`/benefits` (ESS, `apps/portal/src/app/(app)/benefits/page.tsx`): available
plans (elect button only for self-election-enabled plans the caller holds
`benefits.enroll` for), my enrollments (status badge, cancel), and an
elect modal (`BenefitElectForm`) supporting tier selection and dependent
checkboxes sourced from `useSession().employee.dependents` — this page
adds NO dependent-editing UI of its own, reusing the EXISTING (also
`employee.write`-gated) `ProfileEditForm` for that, consistent with the
"reuse the Employee dependents from 1.1" scope line.

`/benefits/admin` (`apps/portal/src/app/(app)/benefits/admin/page.tsx`):
plan authoring, enroll-any-employee (reuses `listEmployees()` for a plain
`<select>` — the SAME "no dedicated picker abstraction" posture asset
assignment/interviewer pickers already document, see
[frontend-admin-console.md](./frontend-admin-console.md)), a
branch-scoped statutory-scheme viewer, and the cost report.
**`FORMULA`-cost-basis plans are deliberately NOT authorable through this
admin form** — the SAME documented gap `apps/portal/src/lib/api/payroll.ts`'s
own `UpsertPayrollComponentInput` already carries (no page in this app
builds a JSON-expression editor); a `FORMULA` plan is created via the API
directly and simply renders correctly here once it exists. Both pages
follow `leave/page.tsx`'s established shape (`useAsync`, `PageSpinner`/
`EmptyState`, a `<Modal>` + local-state form for creates, `<Alert
tone="info">` for a caller with no relevant permission). A new Sidebar
entry appears in both the ESS section (`/benefits`, always visible to a
`benefits.read` holder) and the admin section (`/benefits/admin`, gated on
`benefits.manage`).

## Deferred, documented seams

Not built this step, per its own explicit scope line: a real
provider-integration adapter (an insurance carrier/TPA API) — there is no
DI seam for one yet, since this phase has no external benefits
provider to integrate with; and complex open-enrollment-WINDOW machinery —
`effectiveFrom`/`effectiveTo` already exist on every enrollment so a
future "enrollment period" concept has somewhere to attach, but no
scheduled job enforces "elections only accepted between date X and Y" yet.
Both are natural, additive extensions of what already exists, not
redesigns.

Verified end-to-end over real HTTP by `apps/api/test/benefits.e2e-spec.ts`
(14 tests — see the BUILD_LOG entry for the full list) plus
`apps/portal/tests/benefits.spec.ts` (5 Playwright tests proving UI
wiring only, since the underlying math is already proven at the API
level).
