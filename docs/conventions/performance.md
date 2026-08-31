# Performance management

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 2.2 (Phase 2) — `packages/db`, `packages/shared`,
`apps/api/src/performance`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"2.2 Performance management module" entry) for the full file list and
verification notes. This module is a THIN CONSUMER, not a reimplementer, of
three Phase 0/1 systems: the workflow engine (0.7) for routing/sign-off,
the Employee/org-chart (1.1) for reviewer resolution, and the notifications
hub (0.8) for reminders — the same "consume, don't rebuild" posture Leave
(1.2), Attendance (1.3), and Payroll (2.1) already establish for themselves.
Nothing about RLS, auth/RBAC, the workflow engine's internals, or any other
Phase 0/1 mechanism needed to change for this module to exist.

## The only two genuinely new concepts — both DATA, never a hardcoded enum

This step's brief was explicit: rating scales and review-cycle
configuration must be tenant-configurable data, not code. Two schema
fields carry that weight:

- **`RatingScale.levels`** — a `RatingLevel[]` (`{ value, label,
description? }`, validated by `ratingLevelSchema` in
  `packages/shared/src/validators/performance.validator.ts`) re-validated
  on every write AND read, the same "JSON column has no schema-level
  guarantee of its own" posture Country Pack config / workflow approver
  rules / every other JSON-configured feature in this codebase already
  takes. A tenant can run a 5-point annual scale and a 2-point
  probation pass/fail scale side by side with zero code change — proven
  directly by `performance.e2e-spec.ts`'s first test, which authors both
  through the identical API route and asserts each cycle picks up its own
  scale's shape.
- **`AppraisalCycle.enabledReviewTypes`** — a JSON array of `ReviewType`
  (`SELF`/`MANAGER`/`PEER`/`UPWARD`). **"360" is not a fifth type** — it is
  simply a cycle whose `enabledReviewTypes` includes all four. This
  deliberately avoids inventing a `is360: boolean` flag or a separate
  `ReviewCycleKind` enum: the review-type SET already fully describes what
  reviews get collected, and a "360 cycle" is just the set `{SELF, MANAGER,
PEER, UPWARD}` — no new concept needed.

`ReviewType` itself IS a closed, code-level Postgres enum, not a free-form
string — the same "some things ARE a fixed, closed set" exception
`LeaveType`/`CustomFieldType` already take to this codebase's usual
free-form-`entityType`-string convention (see [leave.md](./leave.md)):
there are exactly four kinds of review relationship a person can have to
another in an appraisal, and that set doesn't grow per-tenant the way a
workflow `entityType` or a custom field's owning entity does.

`AppraisalCycle.eligibleBranchIds`/`eligibleDepartmentIds` are JSON
string-id arrays, not a join table or an FK array — empty means "every
branch/department in the tenant", the identical "opaque JSON id array,
validated at the app layer, no FK, no test in this step's list calls for a
join table" posture `WorkflowInstanceStep.eligibleApproverIds` already
establishes for itself.

## Reviewer resolution — the REAL 1.1 org chart, at the Employee level

`apps/api/src/performance/reviews/reviewer-resolver.util.ts`'s
`resolveAutoReviewers` resolves SELF/MANAGER/UPWARD purely from
`Employee.managerId`/its inverse (`directReports`) — the exact same data
`ApproverResolverService`'s own `MANAGER` rule already resolves through
(see [employee.md](./employee.md) → Feeding the workflow engine), just
stopping at the **Employee** rather than continuing on to a **User** the
way a workflow approver rule does (a review is fundamentally "which
colleague reviews which colleague", not "which account may click approve").
An employee with no manager gets no `MANAGER` `ReviewAssignment` row; an
employee with no direct reports gets no `UPWARD` rows — both are
documented gaps (an assignment is simply never created), not silent
failures or thrown errors, the same "no manager -> root, not dropped"
posture `OrgChartService` already takes for a structurally absent
relationship.

**`PEER` is never auto-resolved.** There is no data source anywhere in
this schema that says who should peer-review whom — that is a genuine
human decision. `POST /performance/appraisals/:id/peer-assignments`
(`performance.manage`) is the only way a `PEER` `ReviewAssignment` is ever
created, exactly as this step's brief calls for ("reviewers resolved via
the employee/org-chart... and explicit peer assignment").

## Enrollment — synchronous, not a BullMQ job

`AppraisalCycleService.open` is the one place a cycle's eligibility
configuration turns into real rows: it lists every `ACTIVE` `Employee`
matching `eligibleBranchIds`/`eligibleDepartmentIds` (empty = everyone),
creates one `Appraisal` per employee, and — for each — resolves and
inserts the applicable auto `ReviewAssignment` rows (intersected against
the cycle's own `enabledReviewTypes`). This runs **synchronously, inside
the request's own transaction** — deliberately NOT a BullMQ job, unlike
Payroll's `PayrollRunProcessor`. The reason is genuinely different scale of
per-employee work: a payroll run computes country-pack-driven tax/
statutory math per employee (real CPU + several queries each); enrollment
here is a handful of cheap inserts per employee (an `Appraisal` row plus
0–3 `ReviewAssignment` rows). If a future tenant's cycle enrollment ever
grows large enough to need queuing, the queue-and-resumable-worker shape
`PayrollRunProcessor`/`AttendanceSummaryProcessor` already establish is the
template to reach for — not built here because nothing in this step's
scale requirement calls for it yet (documented, not silently accepted).

## Review submission vs. the roster — two tables, on purpose

This step's own scope explicitly names both `Review` and
`ReviewAssignment` as separate schema concepts, and the split earns its
keep:

- **`ReviewAssignment`** is the ROSTER — who owes a review of what type,
  `PENDING` until fulfilled. `GET /performance/my-review-assignments`
  (mirroring `GET /workflow/my-pending-approvals`'s exact shape) queries
  ONLY this table — cheap, no join to review content needed to answer
  "what do I still owe."
- **`Review`** is the SUBMITTED CONTENT — created once, on submit, 1:1
  with the assignment it fulfills (`@@unique([tenantId, assignmentId])`).
  It reads as an immutable record of what was actually said;
  `ratingScaleId` is snapshotted from the cycle at submission time (the
  same "snapshot, don't re-derive" posture `LeaveBalance.entitledDays`/
  `PayrollRun.totalGrossBase` already take), so a later rating-scale edit
  never rewrites a historical review's frame of reference.

Submitting a review is gated by row-level ownership only
(`assignment.reviewer.userId === callerUserId`) — **not** by
`performance.manage`, even for `TENANT_ADMIN`. A review is inherently a
personal opinion; nobody should be able to submit one on another person's
behalf, regardless of role.

## Routing + sign-off — THE RULE, applied for real, again

`AppraisalService.submitForApproval` is the ONLY place this module talks
to the workflow engine: it requires every `ReviewAssignment` on the
appraisal to be `SUBMITTED` (an appraisal enrolled with zero assignments —
e.g. an employee with no manager and no cycle-enabled peer/upward
reviewers — can never be submitted; a documented edge case, not silently
waved through with an empty rating), computes `overallRating` as a simple,
**unweighted** average across submitted `Review.overallRating` rows (a
documented simplification — no weighting by review type; a future step
could add a per-cycle weighting config the same way it would add anything
else in this module, as DATA), and calls
`WorkflowEngineService.startInstance` with `entityType:
"PerformanceAppraisal"`, `requesterId` = the appraised employee's own
linked `User.id` (required — same "the workflow engine resolves approvers
relative to a real requester user" constraint Leave/Payroll already
enforce for their own submissions).

`AppraisalWorkflowEventsListener` reacts to `workflow.approved`/
`workflow.rejected` (filtered to `entityType === "PerformanceAppraisal"`)
to flip the appraisal to `COMPLETED`/`REJECTED` — the ONE side-effect the
generic engine has no way to know about itself, the identical shape
`PayrollWorkflowEventsListener`/`LeaveWorkflowEventsListener` already
establish. **`PerformanceController` has deliberately no approve/reject
route** — a pending sign-off is acted on via the SAME generic
`POST /workflow/instances/:id/steps/:stepId/actions` every other
workflow-driven module in this codebase uses, keyed off the
`workflowInstanceId` returned on `GET /performance/appraisals/:id`.

Which template/step chain applies is entirely up to how a tenant (or this
step's own tests) authors the `WorkflowTemplate` for `entityType:
"PerformanceAppraisal"` — a single `MANAGER`-rule step, a
`MANAGER` step then an HR `ROLE` step, a `CONDITIONAL` step gating on the
computed rating, or anything else 0.7's engine already supports — this
module's code never branches on it, mirroring how it never branches on a
`ReviewType` set for a "is this 360" question either.

## Reminders — two new events, sign-off notifications arrive for free

Two new mapped notification event types
(`packages/shared/src/notifications/event-notification-mapping.ts`):

- **`performance.cycle_opened`** — emitted once by
  `AppraisalCycleService.open`. Its recipient resolver case
  (`NotificationRecipientResolverService`) queries every `Appraisal`
  enrolled in the cycle and resolves each employee's linked `User.id` —
  the SAME "DB query needed, can't be pure data" shape `workflow.submitted`'s
  own case already takes.
- **`performance.review_due`** — emitted once per `ReviewAssignment`
  created (both at enrollment, for SELF/MANAGER/UPWARD, and on explicit
  peer assignment). Its payload carries a direct `reviewerUserId` field
  (resolved once, at creation time, by the emitting service) — the SAME
  "resolved eagerly, read directly off the payload" shape
  `workflow.escalated`'s `escalatedToUserId` already takes, rather than a
  DB-query recipient-resolver case. **No linked `User` = no notification**
  (a bulk-imported, not-yet-provisioned employee) — a legitimate no-op,
  the same posture the SMS notification provider and `LogPushProvider`'s
  own doc comments already document for an unset destination.

**No new event was needed for "sign-off needed."** `workflow.submitted`
(already mapped since 0.8) fires the instant `submitForApproval` starts
the instance, and its existing recipient resolver already notifies
whichever approver the template's step resolves to — this is THE RULE's
exact payoff, restated for the third module in a row (Leave, Payroll, now
Performance): a whole feature arrives for free by consuming the workflow
engine instead of emitting a bespoke event.

## Calibration / distribution — pre-aggregated, never live

The task's own instruction was explicit: a calibration view across a
population must not live-`GROUP BY` a potentially huge `appraisals` table
on a dashboard's hot path — the identical "heavy reads never hit the
primary" discipline [analytics-dashboard.md](./analytics-dashboard.md)
already established for headcount/attendance/leave-utilization KPIs.

- **`AppraisalRatingDistributionSnapshot`** is the ONLY table
  `CalibrationService` (the read side) ever queries — one row per
  `(tenant, cycle, branch, department, ratingValue)`, holding a bucketed
  `employeeCount`. A calibration read is a cheap indexed `WHERE cycleId =
...` over this small table, never a scan of `Appraisal` itself, no
  matter how many employees are enrolled in the cycle.
- **`CalibrationProcessor`** (a context-less BullMQ worker, the same
  posture every processor in this codebase takes) computes it: reads every
  `COMPLETED` `Appraisal` for one cycle (joined to `Employee` for branch/
  department only), rounds each `overallRating` to the NEAREST defined
  `RatingScale` level value (`nearestLevelValue`, a documented
  simplification — nearest-neighbor, not interpolated, since a continuous
  average rating has no natural single "level" otherwise), groups via the
  pure, unit-tested `computeCalibrationRows`
  (`calibration-rollup.util.ts`), then **DELETEs the cycle's existing
  snapshot rows and bulk-`createMany`s the fresh ones** — the SAME
  delete-then-recreate shape `AnalyticsRollupProcessor` already uses, for
  the IDENTICAL reason: `departmentId` is nullable, and Postgres treats
  every `NULL` as DISTINCT in a unique index, so an upsert keyed on a
  unique constraint including it would silently insert a fresh duplicate
  row on every re-run for any "no department" bucket rather than updating
  it — see [analytics-dashboard.md](./analytics-dashboard.md)'s own
  write-up of this exact gotcha.
- **Trigger**: `AppraisalWorkflowEventsListener` enqueues one
  `recompute-cycle` job every time an appraisal reaches `COMPLETED`. A full
  recompute is naturally idempotent (delete + recreate from source data
  every time), so firing it once per completion rather than debouncing is
  simple and correct — slightly more work than strictly necessary under
  many concurrent sign-offs in the same cycle, an accepted tradeoff at this
  module's scale, the same "documented, not silently accepted" posture
  0.3/0.7/0.8 already hold themselves to elsewhere in this codebase.
  `POST /performance/cycles/:id/calibration/recompute` is also exposed as
  a manual backfill/test lever, the identical shape
  `POST /analytics/rollup/run` already establishes.

## RBAC, branch scoping, and audit

Four new permissions
(`packages/shared/src/constants/permissions.ts`): `performance.read`/
`performance.write` (seeded onto `TENANT_ADMIN`/`HR_MANAGER`/`MANAGER`/
`EMPLOYEE` — everyone may view/manage their own goals and reviews);
`performance.review` (seeded the same broad way — **anyone** may be
assigned to peer- or upward-review a colleague, so this cannot be
restricted to managers the way `leave.approve` is); `performance.manage`
(`TENANT_ADMIN`/`HR_MANAGER` only — cycle/rating-scale administration,
peer assignment, `submitForApproval`, and calibration analytics: HR-policy
territory, the same tier `custom_field.manage`/`country_pack.override.manage`
already occupy, see [audit-custom-fields.md](./audit-custom-fields.md)).

Branch scoping follows the SAME two-layer shape Leave/Attendance/Analytics
already establish throughout this codebase: `performance.manage` (or
`performance.read` for a caller viewing only their own data) gates the
FEATURE at the route; `allowedBranchIds` (from
`TenantContextService.getBranchIds()`) narrows every query at the service
layer — an explicit out-of-scope `branchId` filter on `GET
/performance/cycles/:id/calibration` returns an EMPTY array, never a
`403`, mirroring `AnalyticsDashboardService`'s identical posture.

Every mutating route this module owns outright is `@AuditLog`'d
(`RatingScale` upsert, `AppraisalCycle` create/open/close, `Goal`
create/update, `ReviewAssignment` peer-assignment creation, `Review`
submission, `Appraisal` submit-for-approval) — reusing 0.9 as-is, zero new
redaction rules needed (no encrypted/sensitive field like `salary`/
`bankDetails` exists anywhere in this module's data). Sign-off itself
(`workflow.approved`/`workflow.rejected`) is already captured generically
by `DomainEventAuditListener`'s existing `workflow.*` subscription — the
same "already covered, only submission needed `@AuditLog`" note
[leave.md](./leave.md) makes for itself.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: `overallRating` is an unweighted average across every submitted
review type (a `SELF` rating counts exactly as much as a `MANAGER`
rating) — a real HR policy would likely want per-type weights, which this
schema has no field for yet; goal hierarchy (`Goal.parentGoalId`) does not
enforce that a parent's `level` is structurally "above" a child's (nothing
stops a TEAM goal from parenting a COMPANY goal) — policing that would
require hardcoding a level ORDER, which nothing in this step's test list
calls for and would only constrain a tenant's own cascading conventions;
calibration's nearest-level-value bucketing is nearest-neighbor, not
interpolated, so two very different continuous averages can land in the
same bucket; there is no cycle-level "force-close and auto-reject
incomplete appraisals" action — `close` is a pure status flip and does not
touch any in-flight `Appraisal`.

Verified end-to-end over real HTTP by
`apps/api/test/performance.e2e-spec.ts` (7 tests: two tenant-authored
rating scales with different level shapes driving two different cycles
through the identical code path, plus a 404 for an unknown scale key; a
full cycle run — goals cascading COMPANY -> TEAM -> INDIVIDUAL with
progress tracking and a COMPANY/TEAM creation permission check, the
`MANAGER` review assignment resolving through the real 1.1 org chart,
reminders landing via the real 0.8 hub as assignments are created,
self+manager+peer reviews submitted plus an explicit peer assignment,
routing + sign-off through the real 0.7 workflow to the real manager with
the averaged `overallRating` landing correctly; calibration/distribution
correct and pre-aggregated, branch-scoped — an HR user restricted to a
branch with zero completed appraisals sees an empty distribution for the
SAME cycle, never a `403` — and RBAC-gated for a plain employee;
cross-tenant isolation via RLS across rating scales, cycles, and
appraisals) plus `calibration-rollup.util.spec.ts` (5 pure-function tests,
including the nullable-`departmentId` non-double-counting proof this
table's whole delete-then-recreate design exists to guard against).
