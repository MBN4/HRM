# Leave

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 1.2 (Phase 1) — `packages/db`, `packages/shared`,
`apps/api/src/leave`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "1.2
leave module" entry) for the full file list and verification notes. This
module is a CONSUMER, not a reimplementer, of four Phase 0/1 systems: the
workflow engine (0.7) for approval, Country Packs (0.5) for entitlements/
holidays/weekends, the Employee/manager relation (1.1) for approver
resolution, and the 0.8 BullMQ queue pattern for scheduled accrual. Nothing
about RLS, auth/RBAC enforcement, or any other Phase 0 mechanism needed to
change for this module to exist.

- **THE RULE, applied for real.** A leave request never grows its own
  approve/reject/cancel logic — `LeaveService.submit` creates the
  `LeaveRequest` row, then calls `WorkflowEngineService.startInstance` with
  `entityType: "LeaveRequest"` and lets the generic engine take over
  completely. `LeaveController` has DELIBERATELY no approve/reject/cancel
  route: a caller acts on a pending leave request via the SAME generic
  routes any other workflow-driven module uses —
  `POST /workflow/instances/:id/steps/:stepId/actions` and
  `POST /workflow/instances/:id/cancel` — using the `workflowInstanceId`
  returned on `GET /leave/requests/:id`. This module's ONLY connection back
  to the approval outcome is `LeaveWorkflowEventsListener`, reacting to the
  engine's own `workflow.approved`/`workflow.rejected`/`workflow.canceled`
  events (see below) — the one leave-specific side-effect (balance deduct/
  restore) the generic engine has no way to know about itself.
- **Leave types are a CLOSED, code-level catalog — not a free-form
  `entityType`-style string.** `LeaveType` (`ANNUAL`/`SICK`/`MATERNITY`/
  `PATERNITY`) is a Postgres enum, deliberately mirroring the four fixed
  keys `CountryPackConfig.leaveDefaults` already commits to
  (`annualDays`/`sickDays`/`maternityDays`/`paternityDays` — see
  [country-packs.md](./country-packs.md)) — the same "some things ARE a
  fixed, closed set" exception `CustomFieldType` already takes to this
  codebase's usual free-form-string convention (`WorkflowInstance.entityType`,
  `Notification.eventType`, ...). What's entirely DATA-driven, never
  hardcoded, is the ENTITLEMENT (day count) for each type —
  `entitlementForType(leaveDefaults, leaveType)`
  (`apps/api/src/leave/leave-entitlement.util.ts`) is the ONE place that
  maps a `LeaveType` to its `leaveDefaults` key; every actual number still
  comes from the resolved Country Pack (+ tenant override).
- **Entitlement resolution — the SAME duplicated-tx-resolver pattern 1.1
  established, for the SAME reason.** `resolveLeavePackConfig`
  (`apps/api/src/leave/leave-country-pack.util.ts`) resolves
  `leaveDefaults`/`workingTime.weekendDays`/`publicHolidays` for a branch —
  structurally identical to `employee-country-pack.util.ts`'s
  `resolveRequiredEmployeeFields`: `CountryPackResolutionService` reads
  `TenantContextService.getTx()`/`.tenantId` internally, which only exist
  inside an HTTP request's `AsyncLocalStorage` context, but this
  resolution must run from BOTH an HTTP request (`LeaveService`) AND the
  context-less accrual worker. The two small lookup queries are
  duplicated with an explicit `tx`/`tenantId` signature; the actual MERGE
  logic (`mergeCountryPackConfig`) is reused as-is, since it's a plain
  function with no request-context dependency — the two-layer override
  model can never drift between request-time resolution and this one. THE
  RULE (see [country-packs.md](./country-packs.md)) holds: nothing in this
  module ever branches on a country code — the exact same functions
  resolve a US branch's 10 annual days and a QA branch's 21, and a US
  Sat/Sun weekend vs. a QA Fri/Sat one.
- **The two-layer override, reused as-is.** A tenant may grant MORE annual/
  sick/maternity/paternity leave than a pack's legal floor via the SAME
  `PUT /country-packs/overrides/:countryCode` route 0.5 already built —
  this module adds NO new override-write surface. `assertLeaveBoundsRespected`/
  `mergeCountryPackConfig`'s clamp-up-to-the-floor behavior (0.5) apply
  unchanged; this module only ever READS the effective config through
  `resolveLeavePackConfig`, proving the override is honored without
  re-implementing any of its enforcement.
- **`LeaveBalance` — one row per (employee, leaveType, calendar year),
  entitlement SNAPSHOTTED at first touch.** `entitledDays` is resolved
  once, when the row is first created (`LeaveBalanceService.
getOrCreateBalance`), and not re-resolved on every read — a mid-year
  override change does not retroactively rewrite an employee's
  already-running balance for that year. Available balance is always
  DERIVED, never stored: `accruedDays + carriedOverDays - usedDays`
  (`availableDays()` in `leave-balance.service.ts`). `ANNUAL`/`SICK` are
  accrued incrementally by the scheduled job (see below) and start each
  year at `accruedDays: 0`; `MATERNITY`/`PATERNITY` are NOT
  monthly-accrued (neither the US nor the Qatar reference pack has a
  ramp-up policy for either, and both are typically "available in full
  once eligible" in real HR practice) — a balance row for either starts
  with `accruedDays` set to the FULL resolved entitlement immediately, so
  the same `availableDays()`/deduct/restore code path works uniformly
  across all four types with no special-casing at the point of use.
- **Balance check BEFORE submission; deduct on approval; restore on
  rejection/cancellation — as literally as 0.7's engine allows.**
  `LeaveService.submit` computes the business-day count and checks
  `availableDays(balance) >= days` BEFORE creating the `LeaveRequest` row
  or starting the workflow instance at all — an insufficient balance never
  reaches the approval chain. The actual deduction happens later, off the
  submitting request, in `LeaveWorkflowEventsListener` (see below) reacting
  to `workflow.approved`. **Why "restore on rejection/cancellation" is a
  documented no-op today, not a missing feature**: 0.7's engine treats
  `APPROVED` as a TERMINAL status (`WorkflowEngineService.
TERMINAL_STATUSES`) — once an instance reaches `APPROVED`, `cancelInstance`
  itself refuses to act on it (`"... is already APPROVED"`), so there is no
  path through the generic engine that reaches `REJECTED`/`CANCELED`
  AFTER a deduction already happened; both can only arrive from a still-
  `PENDING` instance, before any deduction. The listener still implements
  the restore branch (symmetrically, guarded by `LeaveRequest.
balanceApplied`) for correctness and in case a future path ever reverses
  an approval — it is exercised in the schema's design, verified by tests
  as "the balance is correctly untouched by a rejection", not by an actual
  restore-from-nonzero scenario, since 0.7 has no way to construct one.
- **Business-day counting — pure, UTC-safe, per-branch.**
  `countBusinessDays` (`apps/api/src/leave/leave-day-calculator.ts`) walks
  `[startDate, endDate]` inclusive, excluding the resolved pack's
  `workingTime.weekendDays` (US Sat/Sun vs. QA Fri/Sat — proven by the
  SAME function, different pack) and that year's resolved
  `publicHolidays`. Deliberately never touches the server process's local
  timezone: `startDate`/`endDate` are pure calendar dates (`z.coerce.date()`-
  parsed "YYYY-MM-DD" strings parse as UTC midnight per ISO-8601, and
  `LeaveRequest`'s columns are `@db.Date`), and every date-arithmetic step
  (`getUTCDay()`, `setUTCDate()`, the holiday-lookup ISO slice) works
  purely in UTC-normalized terms — see
  [i18n-timezone-rtl.md](./i18n-timezone-rtl.md)'s "UTC in, UTC through"
  convention. `days` is computed ONCE at submission and frozen on the row
  (the same "snapshot, not re-derived" posture `WorkflowInstance.
dataSnapshot` already takes elsewhere in this schema).
- **Scheduled accrual — the 0.8 BullMQ pattern, reused as-is, idempotent
  on TWO layers.** `POST /leave/accrual/run` (`leave.approve`) is today's
  manual trigger — not wired to a real cron/scheduler, the SAME documented,
  accepted tradeoff 0.7's `WorkflowEscalationService.sweepOverdueSteps`
  already takes (see [workflow.md](./workflow.md)): scheduling
  infrastructure is out of this step's scope, and the worker is safe to
  call repeatedly/concurrently. `LeaveAccrualService` (producer) enqueues
  ONE job per `(tenantId, periodYear, periodMonth)`; `LeaveAccrualProcessor`
  (worker, context-less — no `TenantContextService`, `tenantId` arrives as
  explicit job data) iterates that tenant's `ACTIVE` employees and, for
  `ANNUAL`/`SICK` (`ACCRUED_LEAVE_TYPES`), resolves each employee's
  monthly target (`entitledDays / 12`), pro-rates a mid-month joiner via
  `prorationFactorForJoinMonth`, and applies it. IDEMPOTENT on two
  independent layers (this project's "no single layer trusted alone"
  posture — see [tenancy-rls.md](./tenancy-rls.md)): (1)
  `IdempotencyService.execute()` (0.10, Redis-backed — see
  [resilience.md](./resilience.md)) claims
  `tenant:employee:leaveType:year-month` BEFORE any work, called DIRECTLY
  rather than via the HTTP-only `@Idempotent()` decorator (exactly the "or
  call `execute` directly from a service that isn't behind a route at
  all" usage that service's own doc comment invites) — a re-run/retry that
  finds the key `COMPLETED` never re-executes the accrual at all; (2) the
  `LeaveAccrualRun` row's own
  `@@unique([tenantId, employeeId, leaveType, periodYear, periodMonth])`
  constraint is a DATABASE-layer backstop (`P2002` on that `create()` is
  treated as "already accrued", not an error). Pro-ration is join-month
  only — a leaver's LAST partial month is a documented, out-of-scope gap:
  `Employee` has a `TERMINATED` status but no termination DATE column to
  pro-rate against.
- **Carry-over — a documented simplification, not a resolved policy.** No
  data source in this system (neither reference Country Pack) defines a
  real carry-over rule, so `MAX_ANNUAL_CARRY_OVER_DAYS`
  (`leave.constants.ts`) exists as a named, documented placeholder rather
  than silently defaulting to "no carry-over ever" — `LeaveBalance.
carriedOverDays` is modeled and included in `availableDays()`'s formula so
  a future year-end rollover job can populate it without a schema change,
  but no such rollover job is built this step (not required by this
  step's brief, and inventing a carry-over POLICY without a real
  data-driven source would violate THE RULE the same way hardcoding a
  country branch would).
- **Feeding on 1.1's manager relation — for free.** A leave request's
  `requesterId` is the submitting employee's own linked `User.id`
  (`Employee.userId` — required to submit at all, see below); the
  `MANAGER` approver rule then resolves through `ApproverResolverService`
  EXACTLY as 1.1 already wired it (see [employee.md](./employee.md) §
  Feeding the workflow engine) — this module changed NOTHING in
  `apps/api/src/workflow/approver-resolver.service.ts`. Submitting
  requires the target employee to have a linked `User` account
  (`employee.userId`) — a bulk-imported, not-yet-provisioned employee
  cannot submit a leave request, since the workflow engine's approver
  resolution is keyed off a real requester `User`; a 400 says so plainly.
- **Notifications — already fully wired, zero new code.** `workflow.
submitted`/`workflow.approved`/`workflow.rejected` are already mapped
  notification event types (0.8's `NOTIFICATION_EVENT_TYPES`/
  `NotificationRecipientResolverService`, see
  [notifications-queues.md](./notifications-queues.md)) with existing,
  entity-agnostic templates (`"A new {{entityType}} request ({{entityId}})
is waiting for your approval."`, seeded in 0.8) — because a leave
  request is JUST another `WorkflowInstance`, every recipient/locale/
  channel/retry/dead-letter mechanism 0.8 already built applies
  automatically with no leave-specific code. This is the concrete payoff
  of THE RULE: a whole feature ("notify on submit/approve/reject,
  localized") arrived for free by consuming the workflow engine instead
  of emitting its own events.
- **Audit — likewise already covered for approve/reject/cancel; only
  submission needed `@AuditLog`.** `DomainEventAuditListener` (0.9)
  already subscribes to `workflow.*` and derives a generic `"Workflow"`
  audit entry (namespace-derived `entityType`, `instanceId` as
  `entityId`) for every workflow state change, including the ones this
  module's requests go through — see
  [audit-custom-fields.md](./audit-custom-fields.md). `POST
/leave/requests` is `@AuditLog('LeaveRequest', AUDIT_ACTIONS.CREATE)`'d
  (the one HTTP mutation this module owns outright);
  `POST /leave/balances/:employeeId/adjust` (an HR manual balance
  adjustment) is `@AuditLog('LeaveBalance', AUDIT_ACTIONS.UPDATE)`'d the
  same way.
- **RBAC — three new permissions, seeded onto the existing system
  roles.** `leave.read`/`leave.write`/`leave.approve`
  (`packages/shared/src/constants/permissions.ts`) — `TENANT_ADMIN` gets
  all three via `ALL_PERMISSIONS` as always; `HR_MANAGER`/`MANAGER` get
  all three (both approve on behalf of others, view team data);
  `EMPLOYEE` gets only `read`/`write` (self-service: submit and view own
  leave, never someone else's). `leave.approve` is this module's
  "may act on/see ANOTHER employee's leave data" gate — mirroring
  `workflow.manage`'s role relative to `workflow.participate` (see
  [workflow.md](./workflow.md) → Two authorization layers): a caller
  without it is silently narrowed to their own linked `Employee` on every
  read/list/submit route (never a 403 for "someone else's data" — the
  route just answers about the caller's own employee instead), the same
  "RBAC gates the FEATURE, the service layer gates the ROW" two-layer
  shape 0.4 established.
- **Branch scoping — the same two-layer shape as Employee/Workflow.** A
  branch-restricted caller (`allowedBranchIds` from
  `TenantContextService.getBranchIds()`) can only view/adjust leave data
  for employees within their allowed branches — enforced in
  `LeaveService` itself (`assertBranchInScope`/`buildEmployeeScopeWhere`/
  `requireEmployeeInScope`), reading `Employee.branchId` via a relational
  filter (`LeaveRequest.employee.branchId`), since `LeaveRequest` itself
  has no denormalized `branchId` column.
- **Team calendar / availability + conflict detection.** `GET
/leave/calendar` (approved leave, branch/department + date-range scoped)
  and `GET /leave/conflicts` (PENDING/APPROVED leave from DIFFERENT
  employees in the same scope whose date ranges overlap) are both plain
  read queries over `LeaveRequest`/`Employee` — conflict detection is
  purely INFORMATIONAL (flags, never blocks a submission), consistent
  with this step's brief.
- **API surface** (`apps/api/src/leave/leave.controller.ts`):
  `POST /leave/requests`, `GET /leave/requests` (own, or team/tenant with
  `leave.approve`), `GET /leave/requests/:id`, `GET /leave/balances`
  (`?employeeId=&year=`), `POST /leave/balances/:employeeId/adjust`
  (`leave.approve`, HR manual grant/deduct), `GET /leave/calendar`,
  `GET /leave/conflicts`, `POST /leave/accrual/run` (`leave.approve`).
  Approve/reject/cancel are NOT here — see THE RULE above.
- **Known, documented gaps for this phase** (not required by this step's
  brief, flagged so they aren't silently forgotten): no real
  leaver-pro-ration (needs a termination-date column on `Employee`); no
  real carry-over ROLLOVER job (the balance field exists, the policy
  constant is a documented placeholder, no job populates it yet); accrual
  is not wired to a real scheduler (same accepted tradeoff as 0.7's
  escalation sweep); cross-year leave requests use the START date's
  calendar year for balance purposes, a documented simplification for
  the common case of a request that doesn't span a year boundary.
- Verified end-to-end over real HTTP by `apps/api/test/leave.e2e-spec.ts`
  (13 tests: the same code resolving different default entitlements for a
  US vs. QA employee; a tenant override raising annual leave above the
  pack floor reflected in the resolved entitlement, and rejected below
  the floor via the existing 0.5 override endpoint; weekend + holiday
  exclusion producing different business-day counts for a US date range
  spanning New Year's Day/a Sat-Sun weekend vs. a QA date range spanning
  National Sports Day/a Fri-Sat weekend, from the SAME `countBusinessDays`
  function; a real submission running through the real 0.7 workflow to
  the real 1.1 manager, with the balance deducted only once the manager
  actually approves (polled, since the deduction is applied
  asynchronously by the workflow-event listener) and left untouched by a
  rejection; the scheduled accrual job pro-rating a mid-month joiner
  correctly and never double-accruing on a deliberate re-run of the same
  period (asserted both by the accrued amount staying stable and by the
  `LeaveAccrualRun` row count staying exactly 1); conflict detection
  flagging two different employees' overlapping requests in the same
  branch; the team calendar listing approved leave in a date window;
  RBAC deny-by-default for both submission and balance adjustment; and
  cross-tenant isolation — RLS, not application code, is what blocks
  tenant B from reading or listing tenant A's leave requests).
