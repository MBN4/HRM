# Recruitment (ATS) + Onboarding + Offboarding — the employee lifecycle

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 2.3 (Phase 2's final step) — `packages/db`, `packages/shared`,
`apps/api/src/recruitment`, `apps/api/src/onboarding`,
`apps/api/src/offboarding`, `apps/api/src/checklists`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "2.3 Recruitment lifecycle"
entry) for the full file list and verification notes. **PHASE 2 COMPLETE
as of this step** — see CLAUDE.md § 6.

This step is a THIN CONSUMER of five Phase 0/1/2 systems: the workflow
engine (0.7) for every approval, the Employee module (1.1) for the
candidate→Employee conversion, country packs (0.5, via 1.1) for
required-field enforcement, the notification hub (0.8) for reminders,
storage (1.1's `StorageService`/MinIO) for resumes/documents, and Payroll
(2.1) + Auth (0.4) for the offboarding hand-off. Nothing about any of
those systems' own internals changed — see Scope discipline below for the
two narrow, deliberate exceptions.

## The three sub-modules, and the one hard boundary between them

- **Recruitment (ATS)** deals in **CANDIDATES, not yet Employees.**
  `Candidate`/`Application`/`Interview`/`Offer` carry NO `employeeId`
  anywhere in this schema — a candidate who is never hired never touches
  `employees` at all.
- **Onboarding** is the ONE BRIDGE that creates the real `Employee`. It
  starts the moment an `Offer` reaches `ACCEPTED` and ends the moment
  `EmployeeService.create` (1.1, UNMODIFIED) actually runs.
- **Offboarding** is the ONE BRIDGE that hands a leaving `Employee`'s
  final pay to Payroll and revokes their access — the opposite direction,
  Employee → (still an Employee record, `status: TERMINATED`) → no more
  system access.

## Job requisitions + offers — approved via the REAL 0.7 workflow, THE RULE

Neither `JobRequisitionService` nor `OfferService` owns a single line of
approve/reject logic. `submitForApproval` on each just calls
`WorkflowEngineService.startInstance` (`entityType: "JobRequisition"` /
`"Offer"`); `JobRequisitionWorkflowEventsListener`/
`OfferWorkflowEventsListener` react to `workflow.approved`/
`workflow.rejected` to apply the ONE side-effect the generic engine has no
way to know about (flip `status` to `APPROVED`/`REJECTED`) — the identical
shape `PayrollWorkflowEventsListener`/`AppraisalWorkflowEventsListener`
already establish. Neither controller has an approve/reject route: act via
the generic `POST /workflow/instances/:id/steps/:stepId/actions`, keyed
off the `workflowInstanceId` each entity's own `GET` returns. A `JobPosting`
may only be created from an `APPROVED` requisition (enforced in
`JobPostingService.create`, a `409` otherwise) — a posting can never exist
without an approved headcount behind it.

`Offer.status` has SIX values, not five, on purpose: `REJECTED` (the
internal APPROVAL was rejected — an approver said no to sending this offer
at all) is distinct from `DECLINED` (`OfferService.decline` — the
candidate turned down an already-`APPROVED` offer). Conflating the two
would make an audit trail ambiguous about who actually said no.

## The PUBLIC careers API — `@AllowAnonymous()`, not `@Public()`

`CareersController`'s three routes (`GET /careers/postings`,
`GET /careers/postings/:slug`, `POST /careers/postings/:slug/apply`) are
`@AllowAnonymous()` — the SAME "public but tenant-required" pattern
`POST /auth/login` already establishes (see [auth-rbac.md](./auth-rbac.md)):
tenant resolution (the request's Host header, 0.3) and the request's
RLS-scoped transaction still apply exactly as they do for every other
route; a candidate just never presents a JWT. This is deliberately **NOT**
`@Public()` — `@Public()` skips tenant resolution entirely (health checks
have no tenant to bind to at all), which would make a careers page
un-scopable to a tenant in the first place. Because RLS still applies,
`candidates`/`applications`/every other table in this step is still
tenant-isolated even though this route has no authenticated caller — the
SAME hard isolation boundary every other route in this codebase relies on,
proven directly in `recruitment-lifecycle.e2e-spec.ts` (tenant A's
published posting slug simply does not exist under tenant B's Host header).

`CareersService` reads/writes the EXACT SAME `JobPosting`/`Candidate`/
`Application` tables the internal `RecruitmentController` owns — there is
no separate public-facing copy of this data, and no separate "public"
DTO layer narrowing which fields are exposed (a documented, honest gap:
`GET /careers/postings/:slug` currently returns the full internal
`JobPosting` row, including its `requisitionId` — narrowing this to a
purpose-built public DTO is straightforward future work, not done here
since nothing in this step's test list calls for it). Only ever touches
`status: 'PUBLISHED'` postings — a `DRAFT`/`CLOSED` posting's slug resolves
to a `404`, the same "non-disclosure via 404" posture 0.8's notification
mark-read route already holds itself to.

**Candidate identity is deduplicated per tenant by email**
(`Candidate.@@unique([tenantId, email])`) — `CandidateService.upsertByEmail`
is the ONE write path, so a re-applicant (a new resume, a new posting)
always lands on the SAME `Candidate` row; only a fresh `Application` row is
created per posting (`@@unique([tenantId, candidateId, jobPostingId])`— a
duplicate apply to the SAME posting is a `409`, not a silent no-op, so a
candidate gets clear feedback rather than wondering if their resubmission
registered). The resume itself is stored via the EXACT SAME 1.1
`StorageService`/MinIO seam `EmployeeDocument` already uses — metadata
(`resumeStorageKey`) in Postgres, bytes in object storage, addressed by a
caller-constructed, tenant-partitioned key
(`candidates/<tenantId>/<candidateId>/resume-<timestamp>-<fileName>`).

## Candidate pipeline — stages as a closed enum, transitions audited via 0.9

`ApplicationStage` (`APPLIED → SCREEN → INTERVIEW → OFFER → HIRED |
REJECTED`) is a closed, code-level Postgres enum — the same "some things
ARE a fixed, closed set" exception `LeaveType`/`ReviewType` already take
elsewhere in this codebase (a hiring pipeline's stages don't vary
per-tenant the way a workflow `entityType` does).
`PATCH /recruitment/applications/:id/stage` carries NO bespoke history
table — `@AuditLog('Application', 'STAGE_CHANGE')` +
`AuditCaptureService.setBefore()` (the same reference usage
[country-packs.md](./country-packs.md)/[employee.md](./employee.md)
already establish) gives a full, queryable before/after trail via the
GENERIC 0.9 audit log — adding a dedicated stage-history table here would
duplicate a mechanism this codebase already has. Interview scheduling
carries a plain JSON `interviewerUserIds` panel (the same "just a
snapshot of ids, no join table" posture
`WorkflowInstanceStep.eligibleApproverIds` already establishes);
`InterviewScorecard` submission is gated at the ROW level (must be on the
panel, or hold `recruitment.manage` as an override) — the SAME
"permission gates the feature, an explicit manage-tier override widens who
may act" shape `leave.approve` already establishes relative to
`leave.write`.

## Onboarding — the candidate → Employee bridge

- **Started by an EVENT, not a direct call.** `OfferService.accept` emits
  `recruitment.offer_accepted` (`{tenantId, offerId, applicationId,
candidateId}`); `OnboardingOfferAcceptedListener` reacts to it and calls
  `OnboardingService.start`, which is idempotent against a redelivered
  event (an existing `OnboardingProcess` for the same offer is returned
  as-is). This is deliberately the SAME fire-and-forget event-listener
  shape every other cross-module reaction in this codebase already uses
  (`PayrollWorkflowEventsListener`, `LeaveWorkflowEventsListener`, ...) —
  `RecruitmentModule` and `OnboardingModule` have NO direct dependency on
  each other; `OnboardingModule` doesn't even import `RecruitmentModule`.
- **`POST /onboarding/processes/:id/create-employee` calls the REAL,
  UNMODIFIED 1.1 `EmployeeService.create`.** This is the step's central
  claim, proven directly by `recruitment-lifecycle.e2e-spec.ts`: the SAME
  call that already enforces `requiredEmployeeFields` for a direct
  `POST /employees` (US `SSN`/`W4` vs. QA `QATAR_ID`/`VISA_SPONSORSHIP` —
  see [employee.md](./employee.md), [country-packs.md](./country-packs.md))
  enforces them here too, with ZERO new validation code in this module — a
  missing `SSN` on a US-branch onboarding is the exact same `400` (naming
  the missing key) a missing `SSN` on `POST /employees` would produce.
  `packages/shared/src/validators/onboarding.validator.ts`'s
  `completeOnboardingSchema` is built by `.omit()`ing identity/placement
  fields (`firstName`/`lastName`/`personalEmail`/`phone`/`branchId`/
  `employmentType`/`status`/`userId`) from the REAL `createEmployeeSchema`
  rather than redefining an equivalent shape by hand — `statutoryFields`/
  `bankDetails`/`compensation`/`dependents`/`emergencyContacts`/
  `customFields` stay byte-for-byte the same schema `EmployeeService.create`
  already validates against, so this module's conversion body can never
  drift from what `POST /employees` accepts. Identity fields come from the
  already-collected `Candidate` row; branch/employment type/default
  compensation come from the already-`ACCEPTED` `Offer`.
- **The onboarding CHECKLIST is instantiated AFTER the Employee exists, not
  at `start`.** A `MANAGER`-rule checklist task (e.g. "manager
  introduction") has no `Employee.managerId` to resolve against until the
  Employee row is actually created — so `OnboardingService.createEmployee`
  calls `ChecklistService.instantiate` itself, immediately after
  `EmployeeService.create` returns, using the BRAND NEW employee's id.
  Checklist tasks do NOT gate employee creation — a real onboarding flow
  needs the new hire to have system access (an Employee record, eventually
  a linked `User`) before every checklist item (e.g. asset assignment) is
  necessarily done.

## Offboarding — the clean exit bridge

- **Routed via the REAL 0.7 workflow, requester = the DEPARTING employee's
  own linked `User`.** `OffboardingService.initiate` sets
  `requesterId = employee.userId` — deliberately the SAME reuse
  Leave/Performance already establish for their own submissions (see
  [leave.md](./leave.md), [performance.md](./performance.md)): a
  `MANAGER` approver rule resolves relative to the REQUESTER, so making
  the departing employee the requester is what lets `{type: "MANAGER"}`
  correctly resolve to THEIR manager with zero new resolver code. This is
  not a literal claim that the employee "requested" their own
  termination — it is a deliberate, documented reuse of an existing
  mechanism, the same spirit every other workflow-consuming module in this
  codebase already takes. Requires the employee to have a linked `User`
  (the same "the workflow engine resolves approvers relative to a real
  requester user" constraint Leave/Payroll/Performance already enforce).
- **The clearance checklist is instantiated on `workflow.approved`, against
  the ALREADY-EXISTING employee** — no sequencing problem here (unlike
  Onboarding), since the departing employee obviously already exists.
- **`OffboardingService.complete` is gated on EVERY clearance task being
  `COMPLETED`** (`ChecklistService.allCompleted` — an offboarding process
  with zero tasks can never complete) — the same "every assignment
  SUBMITTED before sign-off" gate `AppraisalService.submitForApproval`
  already establishes. It then performs, in order, THREE hand-offs, all to
  EXISTING, UNMODIFIED systems:
  1. **`EmployeeService.update(..., { status: 'TERMINATED' }, ...)`** —
     the REAL 1.1 service, which ALREADY captures `terminatedAt` the
     moment `status` transitions into `TERMINATED` (since 1.5 — see
     [analytics-dashboard.md](./analytics-dashboard.md)). Zero new capture
     logic in this module.
  2. **A `FINAL_SETTLEMENT` Payroll run** — see the next section.
  3. **`TokenService.revokeAllForUser` + `User.status = 'DISABLED'`** — the
     REAL 0.4 revocation primitive `POST /auth/logout-all` already uses
     internally, called directly rather than through HTTP. Both
     independently matter: revoking refresh-token families stops future
     token _rotation_, and flipping `User.status` off `ACTIVE` is what
     `TenantScopeInterceptor` checks on EVERY authenticated request (see
     [auth-rbac.md](./auth-rbac.md)) — so even the departing employee's
     still-cryptographically-valid, unexpired access token is rejected on
     its very next use. Proven directly, not just trusted:
     `recruitment-lifecycle.e2e-spec.ts` calls a protected route with the
     departing employee's ORIGINAL token immediately after offboarding
     completes and asserts a `401`.

## The Payroll FINAL_SETTLEMENT hand-off — reuse, not reimplementation

**The hard constraint this step had to satisfy**: a terminated employee's
`status` is no longer `ACTIVE`, so `PayrollRunProcessor`'s existing
employee-selection query (`WHERE branchId = ? AND status = 'ACTIVE'`)
would NEVER include them in any future run again — without SOME additive
seam, a leaver's final pay (and, for a country like Qatar, their
end-of-service gratuity) would simply never be computed at all. Solving
this correctly required exactly ONE additive schema change and ONE
additive orchestration change to Payroll — both narrowly scoped to
ORCHESTRATION (which employees a run processes), never to the ENGINE (how
correctly a pack's tax/statutory rules are computed), per this step's
explicit "do NOT modify ... payroll engine" boundary:

- **`PayrollRun.runType`** (`REGULAR` | `FINAL_SETTLEMENT`, default
  `REGULAR`) + **`PayrollRun.settlementEmployeeId`** (nullable) — additive
  columns, the same "small additive seam column" pattern
  `Employee.terminatedAt`/`Tenant.baseCurrencyCode` already establish on
  OTHER modules' tables.
- **`PayrollRunProcessor.process`** now branches on `run.runType`: a
  `FINAL_SETTLEMENT` run's employee list is `WHERE id = settlementEmployeeId`
  (exactly the one employee, regardless of their current `status`) instead
  of the branch-wide `ACTIVE` query. This is the ONLY change to that file.
  **`PayrollEngineService.computeForEmployee` — the actual tax/statutory
  ENGINE — is called EXACTLY as it always was, completely unmodified.** A
  `FINAL_SETTLEMENT` run for a Qatar employee computes that period's
  ordinary INCREMENTAL `TIERED_BY_YEARS_OF_SERVICE` gratuity delta — the
  identical function, identical correctness guarantees, identical
  regression proof against the cumulative-double-counting bug
  [payroll.md](./payroll.md) already documents — as any regular monthly
  run would for that same employee.
- **A real uniqueness problem, solved with a hand-written partial index,
  not a schema compromise.** The original blanket
  `@@unique([tenantId, branchId, periodYear, periodMonth])` could not
  simply gain the new nullable `settlementEmployeeId` to its key —
  Postgres treats every `NULL` as DISTINCT in a unique index, so doing
  that would have SILENTLY WEAKENED the existing REGULAR-run idempotency
  guarantee (every `REGULAR` run has `settlementEmployeeId IS NULL`, and
  NULLs never collide with each other). The fix: TWO hand-written PARTIAL
  unique indexes (`add_payroll_final_settlement_seam` migration; Prisma
  has no partial-index DSL, the same "hand-written SQL" posture RLS itself
  already takes — see [tenancy-rls.md](./tenancy-rls.md)) —
  `WHERE run_type = 'REGULAR'` (byte-identical to the original constraint)
  and `WHERE run_type = 'FINAL_SETTLEMENT'` (one settlement run per
  employee per period) — replace the single blanket constraint exactly.
- **An HONEST, documented limitation**: this hand-off computes that final
  period's ORDINARY incremental accrual — it does NOT realize a CUMULATIVE
  lump-sum gratuity payout (summing the employee's entire tenure's accrued
  liability into one final lump sum, the way a real-world end-of-service
  settlement often works). Solving that correctly would mean either
  changing how `PayrollEngineService` computes
  `TIERED_BY_YEARS_OF_SERVICE` for this one run type (explicitly
  off-limits — "do NOT modify ... payroll engine ... business logic") or
  introducing a NEW payroll-owned "cumulative accrued, unpaid liability"
  ledger with no test in this step's own list driving its shape — both
  deferred as a real, deliberate, documented gap (the same "documented,
  not silently accepted" posture the bank-export format/YTD-reconciliation
  gaps already take in payroll.md), not silently under-delivered. What
  THIS step reliably guarantees is the HAND-OFF MECHANISM itself: a
  terminated employee, who would otherwise never appear in another payroll
  run again, gets exactly one more — reusing the identical, already-proven
  CALCULATE/DELEGATE engine, multi-currency rollup, and workflow-approval
  lifecycle every other run already goes through.
- Runs through the SAME `calculate` → `CALCULATED` → (optionally)
  `submitForApproval`/`finalize`/`markPaid` lifecycle every other run
  does — `OffboardingService.complete` only calls `createRun`/`calculate`;
  approving/finalizing/paying out the settlement is a SEPARATE, deliberate
  action via Payroll's own existing routes, exactly as a regular run's
  approval is separate from its calculation.

## Checklists — ONE generic, tenant-configurable mini-engine, shared by both bridges

`apps/api/src/checklists` is deliberately its OWN small module, imported
by BOTH `OnboardingModule` and `OffboardingModule`, rather than two
near-identical implementations — the same "build one generic mechanism,
consumed by many modules" instinct the workflow engine (0.7) and
notification hub (0.8) already embody, scaled down to the much smaller
problem a checklist actually is (assignment + completion tracking, never
routing/sequencing/multi-step approval).

- **`ChecklistTemplate`** (`processType: ONBOARDING | OFFBOARDING`,
  `tasks: Json`) is tenant-configurable DATA, per this step's explicit
  brief — re-validated on every write AND read
  (`checklistTaskDefinitionSchema`), the same posture every other
  JSON-configured feature in this codebase already takes. Proven as DATA,
  not hardcoded, by `recruitment-lifecycle.e2e-spec.ts`: the onboarding and
  offboarding templates in that suite declare entirely different task sets
  and `assigneeRule`s, and the SAME `ChecklistService.instantiate` produces
  correctly different `ChecklistTaskInstance` rows for each.
- **`ChecklistAssigneeRule`** (`SPECIFIC_USER` / `ROLE` / `MANAGER`)
  deliberately MIRRORS THE SHAPE of 0.7's `ApproverRule` — the same "who
  does this land on" problem shows up here — but is NOT that type reused:
  a checklist task needs ONE assignee resolved ONCE, never a multi-step
  approval chain, so pulling in the whole workflow condition/approver-rule
  machinery would be reuse in name only. `resolveChecklistAssignee`
  (`apps/api/src/checklists/checklist-assignee-resolver.util.ts`) is a
  small, purpose-built resolver; `MANAGER` resolves through the SAME real
  1.1 org chart (`Employee.managerId`) `ApproverResolverService`'s own
  `MANAGER` rule and Performance's `resolveAutoReviewers` already resolve
  through. An unresolvable rule (e.g. `MANAGER` for an employee with none)
  simply creates an unassigned task — a documented gap, never a thrown
  error or a blocked checklist.
- **Reminders arrive via ONE new event**, `checklist.task_assigned`
  (`{tenantId, taskId, assigneeUserId, processType, processId}`), mapped
  in `packages/shared/src/notifications/event-notification-mapping.ts` —
  emitted once per task whose `assigneeRule` resolved to a real user,
  picked up by the EXISTING 0.8 notification hub with zero new dispatch
  code (the SAME "direct payload field, no DB query needed" shape
  `workflow.escalated`'s `escalatedToUserId` already uses).
- **`processType`/`processId` are POLYMORPHIC, no FK** — the identical
  `WorkflowInstance.entityType`/`entityId` pattern, for the identical
  reason: neither `OnboardingProcess` nor `OffboardingProcess` is a hard
  dependency of this generic mechanism.

## RBAC, branch scoping, audit, i18n

Five new permissions (`packages/shared/src/constants/permissions.ts`):
`recruitment.read`/`recruitment.write` (`TENANT_ADMIN`/`HR_MANAGER`/
`MANAGER` — a hiring manager plausibly requisitions/reviews candidates for
their own team), `recruitment.manage` (`TENANT_ADMIN`/`HR_MANAGER` only —
submitting for approval, publishing postings, accepting/declining
offers: the financial/legal control points, the same "ownership/security
territory, not general HR policy" tier `payroll.approve`/`audit.read`
already occupy), `onboarding.manage`/`offboarding.manage`
(`TENANT_ADMIN`/`HR_MANAGER` only — the entire employee-lifecycle bridge
is HR-owned). Branch scoping follows the identical two-layer shape every
other module in this codebase already establishes: a permission gates the
FEATURE at the route, `allowedBranchIds` (`TenantContextService.
getBranchIds()`) narrows every query/mutation at the service layer
(`JobRequisitionService.assertBranchAllowed`, `OffboardingService.
requireEmployeeInScope`, ...). Every mutating route this step owns
outright is `@AuditLog`'d; sign-off/approval decisions
(`workflow.approved`/`.rejected`) are already captured generically by
`DomainEventAuditListener`'s existing `workflow.*` subscription — only
`recruitment.*`/`checklist.*` needed to be added as two new wildcard
subscriptions (mechanical, additive, the same one-line addition
`payroll.*`/`performance.*` each needed when THEIR steps landed).
`Offer.proposedSalary` was added to `REDACTED_KEY_PATTERN` — exactly as
sensitive as `Employee.compensation`, redacted the same "over-redact the
whole value" way. No new i18n work was needed this step (no portal/mobile
UI in scope); the public careers API and every internal route reuse this
codebase's existing UTC-timestamp/JSON-response conventions as-is.

## Scope discipline — what this step did NOT touch

`apps/api/src/workflow/*` (used as-is — a requisition/offer/offboarding
approval is a plain `WorkflowTemplate`/`WorkflowInstance`, zero engine
changes), `apps/api/src/employees/employee.service.ts` (called, never
edited — `create`/`update` are invoked exactly as `EmployeesController`
itself invokes them), `apps/api/src/country-packs/*` (required-field
resolution is entirely 1.1's existing job), `apps/api/src/payroll/engine/*`
and `apps/api/src/country-packs/rules-engine/*` (the actual tax/statutory
math — completely untouched; see the FINAL_SETTLEMENT section above for
the ONLY two Payroll files that changed, and why both are orchestration,
never engine), `apps/api/src/auth/auth.service.ts` (untouched —
`AuthModule` gained ONE additive export, `TokenService`, so Offboarding
could inject the SAME revocation primitive `/auth/logout-all` already
uses). RLS policy definitions for every EXISTING table are untouched;
every new table in this step gets the identical `tenant_isolation` policy
pattern.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: the public careers API returns the full internal `JobPosting`
row rather than a narrower public-facing DTO (see above); `Offer` is
strictly one-per-`Application` (`@@unique([tenantId, applicationId])`) — a
revised offer after a decline needs a new `Application` row in this
schema's current design; offboarding's Payroll hand-off computes an
ordinary incremental period accrual, not a cumulative lump-sum gratuity
payout (see the FINAL_SETTLEMENT section's own honest limitation note);
`ChecklistTaskInstance.assigneeUserId` resolution is a one-time snapshot —
reassigning an in-flight task to someone else has no dedicated route yet
(delete-and-reinstantiate, or a direct DB edit, are the only levers today);
there is no cycle/dedupe protection against creating two
`WorkflowTemplate`s for the same new `entityType` beyond what 0.7's own
"highest active version wins" resolution already provides.

Verified end-to-end over real HTTP by
`apps/api/test/recruitment-lifecycle.e2e-spec.ts` (14 tests: a job
requisition approved through the real 0.7 workflow; a posting created from
it and published; the PUBLIC careers API listing/serving it and accepting
an application with a resume upload with NO auth, correctly rejecting a
duplicate apply; candidate pipeline stage transitions captured in the 0.9
audit trail; an interview scheduled and scored by a real panel member; an
offer created, approved through the real workflow, and accepted; offer
acceptance starting a real onboarding process via the fire-and-forget
`recruitment.offer_accepted` event; creating the Employee correctly
rejecting a US-branch submission missing `SSN`/`W4` and succeeding once
supplied — the SAME `EmployeeService.create` `POST /employees` itself
uses; the onboarding checklist instantiated from tenant-configurable DATA
with real 0.8 notifications landing, a `requiresDocument` task correctly
rejecting completion with no attachment and succeeding with one; a
termination routed through the real workflow to the real 1.1 manager; the
clearance checklist gating completion; completing offboarding setting
`Employee.status`/`terminatedAt`, revoking access (both the DB flag and a
live, previously-valid access token now rejected), and triggering a real
Payroll `FINAL_SETTLEMENT` run whose reported Qatar gratuity accrual is
explicitly bounded well below the cumulative-total figure the engine's own
documented double-counting bug would have produced; and cross-tenant
isolation via RLS across every new table, including the public careers
route).
