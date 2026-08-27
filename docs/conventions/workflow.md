# Workflow / approval engine

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.7 — `packages/db`, `packages/shared`,
`apps/api/src/workflow`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"0.7 workflow / approval engine" entry) for the full file list and
verification notes.

- **THE RULE.** There is exactly ONE approval engine in this codebase.
  Leave, expenses, regularizations, offer approvals, and anything else
  that ever needs a multi-step sign-off ALL consume
  `WorkflowEngineService`/the five routes on `WorkflowController` — no
  future module may grow its own approve/reject/delegate logic. A
  consuming module's only job is: define a `WorkflowTemplate` for its
  `entityType`, call `POST /workflow/instances` when something needs
  approval, and react to `workflow.*` events. Everything about WHO
  approves and in what order is DATA (`WorkflowStep.approverRule`/
  `condition`), never a code branch on entity type.
- **Core model**: `WorkflowTemplate` (named, versioned, `isActive` —
  resolution picks the highest-version active template for a
  `(tenantId, entityType)`, same pattern as 0.5's `CountryPack` — see
  [country-packs.md](./country-packs.md)) owns ordered `WorkflowStep`s.
  `WorkflowInstance` is the POLYMORPHIC running approval (`entityType` +
  `entityId`, no FK to the owning module's table — deliberately, since it
  usually doesn't exist yet and never should be a hard dependency of the
  generic engine) with a `dataSnapshot` (JSON, e.g.
  `{ amount, days, leaveType }`) captured ONCE at submission and never
  re-read from the source module — conditions/auto-approval/escalation
  all evaluate against this frozen copy, so an approval in flight is
  unaffected by the source record changing underneath it.
  `WorkflowInstanceStep` is the per-instance MATERIALIZATION of each
  template step (one row per template step, including `SKIPPED` ones —
  see Conditional branching below) — this is what lets one template be
  reused across many instances while each tracks its own resolved
  approvers/progress independently, and is the audit-friendly record of
  "which steps actually applied to THIS request and why". `WorkflowAction`
  is the append-only, never-updated audit trail: one row per
  approve/reject/delegate/comment/escalate/auto-approve/cancel, who (null
  for the two system-initiated types) and when.
- **Sequential vs. parallel — one `order` column.** Steps sharing the
  same `order` within a template are a PARALLEL group: ALL of them must
  reach `APPROVED` before the instance advances past that `order`;
  different `order` values run SEQUENTIALLY.
  `WorkflowEngineService.activateNextGroup` (private) is the only place
  that decides "what's next" — it looks at the lowest `order` among
  still-`PENDING` (non-skipped, non-yet-activated) instance steps,
  activates every step in that group, and recurses immediately if the
  whole group turns out to auto-approve (see below) so a chain that
  needs no human at all resolves straight through in one call. No
  `PENDING` steps left at all -> the instance is `APPROVED`.
- **Approver rules — resolved by RULE, never a fixed user**
  (`ApproverRule`, `packages/shared/src/validators/workflow.validator.ts`;
  resolved by `apps/api/src/workflow/approver-resolver.service.ts`):
  `SPECIFIC_USER` (a literal user id), `ROLE` (any `ACTIVE` user holding
  that role name in the tenant — reads the live `Role`/`UserRole` rows,
  same DB-backed-not-enum-backed posture as RBAC itself — see
  [auth-rbac.md](./auth-rbac.md)), `MANAGER`, `BRANCH_HEAD`,
  `DEPARTMENT_HEAD`, and `CONDITIONAL` (picks between two entirely
  different sub-rules based on a `WorkflowCondition` evaluated against the
  instance's `dataSnapshot` — e.g. "route to the CFO if amount >
  threshold, else the finance manager"; a DIFFERENT mechanism from a
  step's own `condition` field, which decides whether a step exists in
  the chain at all, not who approves an existing one).
  **`MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD` are PLUGGABLE SEAMS**,
  not real Employee-module data (phase 1.1 doesn't exist yet):
  - `MANAGER` resolves against `User.managerId` — a new nullable
    self-relation column added to `User` this step specifically so this
    rule has something to resolve against (same composite-self-relation-FK
    pattern as `Branch.parentBranchId`/`Department.parentDepartmentId` —
    see [tenancy-rls.md](./tenancy-rls.md)).
  - `BRANCH_HEAD`/`DEPARTMENT_HEAD` resolve against new nullable
    `Branch.headUserId`/`Department.headUserId` columns (composite FK to
    `User`, same pattern), and need to know WHICH branch/department the
    request is even about — `dataSnapshot.branchId`/`.departmentId` wins
    if the submitting module supplies one; failing that, `BRANCH_HEAD`
    falls back to the requester's sole `UserBranch` row if exactly one
    exists (there is no "requester's department" data source at all yet,
    so `DEPARTMENT_HEAD` has no fallback).
    When the real Employee module lands, only
    `ApproverResolverService`'s few private helper methods should need to
    change to query real employee data — the `ApproverRule` type, the
    engine's state machine, and every other rule kind are unaffected.
- **Conditional branching reuses 0.5's rules-engine APPROACH, not its
  file** (this step does not modify `packages/db/src/country-packs/`
  or `packages/shared/src/validators/rules-engine.validator.ts` — see
  the header comment of `packages/shared/src/validators/workflow.validator.ts`
  for the full reasoning). Reused literally: `ALLOWED_EXPR_OPERATORS`
  (imported, not redefined) and — the important part — the SECURITY
  PATTERN (see [country-packs.md](./country-packs.md) → Rules engine): a
  fixed, closed JSON AST (`WorkflowValueExpr`, structurally identical to
  0.5's `Expr`) interpreted structurally by
  `apps/api/src/workflow/condition-evaluator.ts`, never a string parsed
  or `eval`'d. What's NEW, and why a second schema is not "a second
  UNSAFE evaluator": (1) variable names are OPEN (`z.string()`), not
  0.5's closed payroll-specific enum — the workflow `dataSnapshot` is
  intentionally polymorphic per consuming module, and the safety
  property still holds structurally, since the evaluator only ever does
  a typed lookup on an object THIS code populated, never arbitrary
  property access on untrusted input; (2) a BOOLEAN layer
  (`WorkflowCondition`: `compare`/`and`/`or`/`not`) sits on top of the
  arithmetic layer, because 0.5 only ever needed to compute a NUMBER
  (a tax amount) and a workflow condition is inherently a yes/no
  decision — arithmetic alone can't express "amount > threshold".
  Numeric comparisons only (no string equality) — a deliberate,
  documented scope boundary, extend it deliberately if a real module
  ever needs one, don't work around it elsewhere. A step's `condition`
  (gates whether the step applies to THIS instance at all — the
  "amount > threshold requires an extra step" mechanism) and
  `autoApproveCondition` (gates whether the step needs a human at all)
  are both `WorkflowCondition`, evaluated once at instance-creation
  (`condition`, baked into whether the instance step is created as
  `PENDING` or `SKIPPED`) or once at step-activation
  (`autoApproveCondition`) respectively — re-validated against the
  shared schema on read, same "JSON column has no guarantee of its own"
  posture as every other JSON-configured feature in this codebase.
- **Delegation and escalation both REASSIGN (replace), not add.** Once
  `WorkflowInstanceStep.delegatedToUserId` is set (via a `DELEGATE`
  action from a currently-eligible approver, to any other `ACTIVE`
  tenant user), ONLY that user may act on the step — not the original
  approver(s), not even the delegator. Escalation (fired by
  `WorkflowEscalationService.sweepOverdueSteps()` for any `ACTIVE` step
  past its `dueAt`, resolving the template step's `escalationRule`) sets
  `escalatedToUserId` the same way, with the same replace semantics —
  picked for one consistent mental model and so both are equally easy
  to test ("delegation/escalation reassigns" means exactly that, not
  "adds a second possible approver"). `actOnStep`'s eligibility check is
  `delegatedToUserId` if set, else `escalatedToUserId` if set, else the
  step's `eligibleApproverIds` snapshot.
- **The escalation sweep is a cross-tenant system operation, called
  directly (no scheduler wired yet).**
  `WorkflowEscalationService.sweepOverdueSteps()` discovers overdue
  steps across EVERY tenant via `prisma` (the owner/admin client — the
  same class of cross-tenant use `LicensingAdminService` already makes
  of it, see [licensing-feature-flags.md](./licensing-feature-flags.md)
  → Platform context), then performs each actual escalation write inside
  a proper `withTenantContext` transaction for that step's own tenant, so
  RLS is enforced for the mutation exactly as everywhere else. Not wired
  to a real cron/BullMQ job — that's scheduling infrastructure out of
  this step's scope (0.8's notification hub, or a future scheduled job,
  can call this method directly); it's safe to call repeatedly/
  concurrently (`escalatedToUserId IS NULL` in the discovery filter, plus
  a re-check inside `escalateStep`, means an already-escalated step is
  never escalated twice).
- **Auto-approval** (`WorkflowStep.autoApproveCondition`): when a step
  activates and this evaluates true against the instance's
  `dataSnapshot`, the step resolves straight to `APPROVED` with a
  `WorkflowAction` of type `AUTO_APPROVE` (`actorUserId: null`) — no
  human ever sees it. A DIFFERENT mechanism from `condition` (which
  decides whether the step exists in the chain at all): here the step
  exists, it just needs nobody to click anything.
- **Rejection is fail-fast; a canceled/rejected instance's still-`ACTIVE`
  steps are frozen, not rewritten.** Any `REJECT` on any step
  (sequential or one of several parallel siblings) immediately
  finalizes the WHOLE instance as `REJECTED` — siblings that hadn't
  been decided yet keep whatever status they were last in; the
  instance's own terminal `status` is what `actOnStep` actually checks
  before accepting any further action, so a stale-looking sibling step
  can never be acted on again regardless. `cancelInstance` (the
  requester, or a `workflow.manage` holder) behaves the same way.
- **Events, wired now for 0.8/0.9 to consume later**
  (`apps/api/src/workflow/workflow-events.ts`, same deferred-persistence
  pattern as `auth-events.ts`/`licensing-events.ts`): `workflow.submitted`,
  `workflow.step_approved` (every individual step decision, human or
  auto), `workflow.approved`, `workflow.rejected`, `workflow.escalated`,
  plus `workflow.delegated` and `workflow.canceled` (both clearly
  "state changes" per this step's brief, even though not in its
  named-example list) — consumed at this step only by
  `WorkflowEventsListener`, which just logs them; superseded by 0.9's
  `DomainEventAuditListener` and 0.8's notification dispatch — see
  [audit-custom-fields.md](./audit-custom-fields.md) and
  [notifications-queues.md](./notifications-queues.md).
- **API surface is exactly five generic routes**
  (`apps/api/src/workflow/workflow.controller.ts`): `POST
/workflow/instances` (start — defaults `requesterId` to the caller;
  submitting on someone else's behalf needs `workflow.manage`),
  `GET /workflow/instances/:id` (status/history — instance + steps +
  actions), `POST /workflow/instances/:id/steps/:stepId/actions`
  (approve/reject/delegate/comment), `POST /workflow/instances/:id/cancel`,
  `GET /workflow/my-pending-approvals`. Deliberately no template-authoring
  endpoint this step — templates/steps are created directly via the
  owner `prisma` client (seeding/fixtures), the same way RBAC roles,
  country packs, and licenses are all set up elsewhere in this codebase
  before/without a dedicated admin UI; add one only when a real need
  for tenant-side template editing shows up.
- **Two authorization layers, same shape as branch scoping** (see
  [auth-rbac.md](./auth-rbac.md) → Branch scoping). `workflow.participate`
  (granted to every seeded system role) is the coarse RBAC gate — "may
  use the workflow system at all"; a NEW `PERMISSIONS.WORKFLOW_MANAGE`
  (`TENANT_ADMIN` implicitly, `HR_MANAGER` explicitly) is required to
  start an instance on someone else's behalf or cancel someone else's
  instance. WHICH specific instances/steps a caller may act on is a
  separate, row-level check the service layer enforces (standing on an
  instance = requester, an eligible approver on any of its steps, or
  `workflow.manage`; eligibility on a step = in its current
  `eligibleApproverIds`/`delegatedToUserId`/`escalatedToUserId`) — RBAC
  permission gates the FEATURE, the service layer gates the ROW, exactly
  the two-layer shape 0.4's branch scoping established on top of tenant
  RLS.
- **Known scaling tradeoff**: `myPendingApprovals` fetches every
  tenant-wide `ACTIVE` instance step and filters eligibility in
  application code rather than pushing the "is this user in this JSON
  array" check into the SQL query — simpler and unambiguously correct
  today; worth revisiting (e.g. a dedicated eligibility join table) if
  per-tenant instance-step volume ever makes this a real cost, same
  "documented, not silently accepted" posture as 0.3's held-open-
  transaction tradeoff (see [tenant-resolution.md](./tenant-resolution.md)).
- Verified end-to-end over real HTTP by `apps/api/test/workflow.e2e-spec.ts`
  (12 tests: a sequential leave-style flow manager -> HR run to
  completion, a conditional expense-style flow both skipping and adding
  its HR step by amount, a parallel step blocked until both approvers
  act, delegation reassigning who may approve, escalation firing on a
  simulated timeout and reassigning the same way, auto-approval with no
  human action, rejection terminating the whole instance, cancellation
  blocking further action, deny-by-default cancel by a non-requester,
  and cross-tenant isolation on both template resolution and instance
  visibility) plus `apps/api/src/workflow/condition-evaluator.spec.ts`
  (14 unit tests: arithmetic/comparison/boolean-combinator correctness
  and the sandbox rejecting every out-of-whitelist shape).
