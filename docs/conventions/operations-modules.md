# Operations modules (Expenses · Assets · Helpdesk · Announcements/Policies)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.1 (Phase 3's first slice) — `packages/db`, `packages/shared`,
`apps/api/src/{expenses,assets,helpdesk,announcements}`, `apps/portal`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "3.1 operations modules" entry)
for the full file list and verification notes. Four THIN modules, each a
consumer of systems that already exist — the workflow engine (0.7), storage
(1.1), notifications (0.8), audit (0.9), RBAC (0.4) — none of which needed
to change for any of the four to exist. This is [`frontend-admin-console.md`](./frontend-admin-console.md)'s
own pattern one more time: backend + portal UI together, built directly on
2.4's exact conventions (`lib/api/*.ts` one-function-per-route files,
`useAsync`, the `components/ui/*` design system, `WorkflowStatusPanel`,
session-aware i18n/RTL, real-Playwright testing).

## Expenses & Reimbursements

- **Lifecycle**: `DRAFT` (`ExpenseClaimService.createDraft` resolves the
  caller's own `Employee` the SAME self-service-vs-`expense.manage`
  resolution shape `LeaveService.resolveTargetEmployee` already
  establishes) → lines added one at a time, each persisted immediately
  (`POST /expenses/claims/:id/lines`) → `submit` (policy-limit enforcement,
  then the REAL 0.7 workflow) → `SUBMITTED` → `APPROVED`/`REJECTED` (via
  `ExpenseWorkflowEventsListener`, THE RULE — this module owns zero
  approve/reject logic, mirroring `OfferWorkflowEventsListener` exactly) →
  `REIMBURSED` (Payroll's own hand-off, see below — never triggered by this
  module).
- **The workflow entityType is literally `"EXPENSE_CLAIM"`** — the SAME
  string `workflow.e2e-spec.ts`'s own reference conditional-amount fixture
  has used since 0.7 ("a conditional expense-style flow... branching via
  the sandboxed condition evaluator"). A tenant's real amount-thresholded
  approval chain (`{ approverRule: MANAGER }` always, `{ approverRule:
ROLE('HR_MANAGER'), condition: amountGreaterThan(N) }` above a
  threshold) is authored the identical way every other workflow-driven
  module's template is — directly via the owner `prisma` client
  (fixtures/tests today; there is still no template-authoring endpoint
  anywhere in this codebase, unchanged since 0.7). Because this reuses the
  EXACT pre-existing demo entityType string, `workflow.e2e-spec.ts`'s own
  synthetic `EXPENSE_CLAIM` instances (non-UUID `entityId`s like
  `"expense-small"`) now also reach `ExpenseWorkflowEventsListener` when
  the whole suite runs together — caught, logged, and non-fatal (the
  listener's `tx.expenseClaim.findUnique` throws on the malformed id, which
  is swallowed the same way every other terminal-event listener in this
  codebase already catches-and-logs). This is the SAME class of benign,
  non-failing cross-suite event-bus artifact
  [`notifications-queues.md`](./notifications-queues.md) already documents
  for `workflow.submitted` racing test teardown — never affects an
  assertion, not a production concern (a real deployment never emits a
  non-UUID `EXPENSE_CLAIM` id).
- **Policy limits are DATA, enforced at SUBMIT, not at line-add time.**
  `ExpenseCategory.policyLimitAmount` (`Decimal?`, `null` = unlimited) is
  tenant-configurable; a claim can be drafted and corrected freely, and
  `ExpenseClaimService.submit` checks every line against its OWN category's
  limit, a `400` naming exactly which line/category/limit failed — the
  same "no meaningless combination silently accepted" posture this
  codebase takes everywhere policy limits are enforced.
- **Multi-currency — reuses Payroll's OWN `ExchangeRateService`, the SAME
  Decimal approach, not a reimplementation.** A claim's `currencyCode`
  is resolved from the claimant's branch's effective Country Pack
  (`resolvePayrollPackConfig`, imported directly from `apps/api/src/payroll`
  — Payroll's own free function with an explicit `tx`/`tenantId` signature,
  usable outside a request context, see [payroll.md](./payroll.md)). At
  `submit`, `totalAmountBaseCurrency`/`exchangeRateToBase` are resolved
  ONCE against the tenant's `baseCurrencyCode` and SNAPSHOTTED onto the
  claim — never re-resolved later, the same "snapshot, don't re-derive"
  posture `PayrollRun.exchangeRateToBase` already takes. `PayrollModule`
  gained one additive export (`ExchangeRateService`, alongside its existing
  `PayrollRunService` export) so `ExpensesModule` can inject it directly —
  the one deliberate cross-module DI dependency this step adds, always in
  the "consumer imports the reused module" direction every other
  cross-module reuse in this codebase already takes.
- **The reimbursement hand-off — orchestration only, the payroll ENGINE is
  completely untouched, mirroring the 2.3 FINAL_SETTLEMENT hand-off
  exactly.** `ExpenseClaimService` (this module) never computes pay and
  never calls into Payroll at all — an `APPROVED` claim just sits there.
  `PayrollRunProcessor.processEmployee` (the SAME file 2.3 already touched
  for `FINAL_SETTLEMENT`) gained one additive step,
  `mergeReimbursements`: immediately after `PayrollEngineService.
computeForEmployee`/the DELEGATE adapter returns its result (the ENGINE
  call itself, completely unmodified), it sums every APPROVED,
  not-yet-consumed `ExpenseClaim` for that employee — regardless of
  `run.runType`, so a leaver's outstanding approved claims are deliberately
  paid out in their `FINAL_SETTLEMENT` run too — converts into the RUN's
  own currency via `ExchangeRateService` (already a processor dependency),
  and adds the total straight onto `netPay`/`employerCost` (reimbursements
  are non-taxable — never routed through `tax.layers`/`statutory.
components`) plus one appended `{key: 'reimbursements', ...}`
  `componentBreakdown` line item. Once the line is durably written, every
  consumed claim is marked `REIMBURSED` with `reimbursementPayrollRunLineId`
  set (a plain id, no FK — the SAME polymorphic "just an id" pattern
  `OffboardingProcess.settlementPayrollRunId` already establishes).
  **A claim approved AFTER its employee's line is already `COMPUTED` in a
  given run is picked up on the NEXT run, never retroactively** — the same
  "resumability skips an already-`COMPUTED` employee entirely" posture
  `payroll.md` already documents for itself; a real payroll process needs
  claims approved before that period's `calculate` runs.
- **Receipts** — the SAME `StorageService`/MinIO seam `EmployeeDocument`
  established in 1.1: metadata (`ExpenseLine.receiptStorageKey`) in
  Postgres, bytes in object storage, addressed by a caller-constructed,
  tenant-partitioned key (`expenses/<tenantId>/<claimId>/<lineId>-...`).
  Upload is multipart (`POST .../receipt`); download STREAMS the object
  back (`GET .../receipt`, `StreamableFile`) — deliberately carries NO
  `@AuditLog`/`AuditInterceptor`, the same `payroll.md`-documented lesson
  ("a `StreamableFile`-returning route must never carry `AuditInterceptor`"
  — its generic redaction walk crashes on a live stream).
- **RBAC**: `expense.read`/`expense.write` (self-service — submit/view/
  comment on YOUR OWN claim, seeded onto every system role including
  `EMPLOYEE`) vs. `expense.manage` (category CRUD, act on ANY employee's
  claim — `TENANT_ADMIN`/`HR_MANAGER` only).

## Asset Management

- **The register + assignment lifecycle.** `Asset.status` (`AVAILABLE` |
  `ASSIGNED` | `IN_MAINTENANCE` | `RETIRED`) is a plain denormalized cache,
  maintained by `AssetService` on every assign/return/maintenance
  transition — never derived by a live join at read time (the schema's own
  doc comment says so explicitly). `AssetAssignment` is APPEND-ONLY per
  assign/return CYCLE (not one row per asset) — an asset reassigned three
  times over its life has three rows, giving a real assignment HISTORY for
  free, the same "append, don't overwrite" posture `WorkflowAction` already
  takes for its own audit trail.
- **The offboarding clearance checklist's real "asset return" step — a
  placeholder 2.3 explicitly named as a Phase 3 candidate, now wired for
  real.** `ChecklistService.complete` itself is COMPLETELY UNCHANGED and
  stays fully generic (the checklist mini-engine owns zero entity-specific
  logic, by design — see [recruitment-lifecycle.md](./recruitment-lifecycle.md)).
  The wiring lives entirely in the CONSUMING module: `OffboardingService`
  gained one new method, `completeTask`, which — ONLY when the task's `key`
  is exactly `ASSET_RETURN_CHECKLIST_TASK_KEY` (`'asset_return'`, exported
  from `apps/api/src/assets/assets.constants.ts` — literally the SAME
  string `recruitment-lifecycle.e2e-spec.ts`'s own pre-existing offboarding
  checklist fixture already used since 2.3, so no existing test needed to
  change) — resolves the process's employee and calls
  `AssetService.hasOutstandingAssignments`; a `409` blocks completion while
  any `ASSIGNED` `AssetAssignment` row remains for that employee. Every
  OTHER checklist task key (access badge, exit interview, ...) completes
  exactly as it always has. `OffboardingModule` gained one additive import
  (`AssetsModule`) for this — the SAME "the consuming module imports the
  reused one" direction the Expense→Payroll hand-off above also takes.
- **Assignment picker** reuses `GET /employees` (a `<select>` backed by
  `listEmployees()`) rather than a dedicated endpoint — the SAME "no
  picker abstraction" posture [frontend-admin-console.md](./frontend-admin-console.md)
  already documents for interviewer/manager pickers.
- **RBAC**: `asset.read` (view the register, view YOUR OWN assigned
  assets — seeded onto every role including `EMPLOYEE`) vs. `asset.manage`
  (register/assign/return/maintenance — `TENANT_ADMIN`/`HR_MANAGER` only).

## HR Helpdesk / Ticketing

- **SLA is tenant-configurable DATA, resolved ONCE at ticket creation,
  never re-derived.** `TicketCategory.defaultSlaMinutes` (nullable — no
  SLA at all is a legitimate category) is read once by `TicketService.
create` into `Ticket.slaDueAt` — a later edit to a category's SLA never
  rewrites an already-open ticket's due time, the same "snapshot, don't
  re-derive" posture `PayrollRun.exchangeRateToBase`/`LeaveBalance.
entitledDays` already take.
- **The escalation sweep — the IDENTICAL shape `WorkflowEscalationService.
sweepOverdueSteps` already establishes in 0.7**, right down to the
  cross-tenant discovery/per-tenant-transaction-mutation split:
  `TicketSlaService.sweepOverdueTickets()` discovers every `OPEN`/
  `IN_PROGRESS`, not-yet-`slaBreached` ticket past `slaDueAt` across ALL
  tenants via the owner `prisma` client, then flips `slaBreached` and
  emits `helpdesk.ticket_escalated` inside a proper `withTenantContext`
  transaction for that ticket's own tenant. NOT wired to a real
  scheduler (BullMQ, cron) — exactly like 0.7's own sweep, out of this
  step's scope; call it from wherever a future scheduled job ends up
  living. Safe to call repeatedly/concurrently (`slaBreached: false` in
  the discovery filter, plus a re-check inside the transaction).
- **Escalation notification — a NEW mapped event,
  `helpdesk.ticket_escalated`.** Recipient resolution
  (`NotificationRecipientResolverService`) is the current assignee if one
  is set (a direct payload field, no DB query — the SAME shape
  `workflow.escalated`'s `escalatedToUserId` already uses), else every
  ACTIVE `HR_MANAGER` in the tenant (the SAME "no assignee yet, notify the
  owning role" fallback `licensing.issued`/`.revoked` already establish
  for `TENANT_ADMIN`). `DomainEventAuditListener`/`NotificationDispatchListener`
  each gained one mechanical, additive `@OnEvent('helpdesk.*')`
  subscription — the same one-line addition every prior step's own new
  event namespace already required.
- **Comments (thread) + attachments (via 1.1's `StorageService`/MinIO,
  same key convention as receipts above)** — both scoped by the SAME
  "you may act on your own ticket, or hold `helpdesk.manage`" row-level
  check, `TicketService.assertCanView`.
- **RBAC**: `helpdesk.read`/`helpdesk.write` (raise/comment on YOUR OWN
  tickets — seeded onto every role including `EMPLOYEE`) vs.
  `helpdesk.manage` (assign/change status on ANY ticket, category CRUD —
  `TENANT_ADMIN`/`HR_MANAGER` only).

## Announcements & Policies

- **Targeting — an empty array means unrestricted, the same "absence
  means unrestricted" posture branch scoping's own `allowedBranchIds:
null` already takes elsewhere**, just expressed as an empty
  `targetBranchIds`/`targetDepartmentIds` array (Postgres native
  `Uuid[]` columns) since there's no natural "null list" to lean on here.
  `AnnouncementService.listForCaller` resolves the caller's own linked
  `Employee` (branch/department) and filters; a caller with NO `Employee`
  record (an admin-only account) sees only fully-untargeted announcements
  — the same "your own data is never out of scope, but there's no scope
  to widen into without an Employee record" posture this codebase already
  takes elsewhere.
- **This is the REAL implementation behind the ESS "announcements seam"
  1.4 deliberately left as a placeholder** (`apps/portal/src/app/(app)/
announcements/page.tsx` — its own doc comment said exactly this: "the
  real announcements module is Phase 3"). The dashboard's own
  "coming soon" announcements widget (`apps/portal/src/app/(app)/
dashboard/page.tsx`) is wired to the same real feed for the same reason
  — both were the two places 1.4's placeholder existed, both are now
  real. `apps/mobile`'s equivalent placeholder screens
  (`AnnouncementsScreen.tsx`/`HomeScreen.tsx`, `apps/mobile/src/i18n/
messages.ts`'s own duplicated `announcements.comingSoon` key) are
  DELIBERATELY untouched — mobile work was not in this step's scope, the
  same "apps/portal/apps/mobile untouched by this step" boundary 2.3 held
  itself to for its own out-of-scope surfaces.
- **Policies — versioned, republish-is-a-new-row, the SAME shape
  `CountryPack` already establishes at global scope, here at tenant
  scope.** `PolicyService.create` looks up the highest existing `version`
  for that tenant+title, deactivates the previous `isActive` row (if any),
  and creates version+1 — an in-place edit never happens, so a
  `PolicyAcknowledgment` always unambiguously means "acknowledged THIS
  exact version." Only currently-`isActive`+published policies appear on
  `GET /policies` (the ESS read); the full version history is
  `GET /policies/admin`.
- **E-acknowledgment tracking** — `PolicyAcknowledgment` is a plain
  `@@unique([tenantId, policyId, userId])` upsert (`POST /policies/:id/
acknowledge`, idempotent — acknowledging twice is a no-op, not an
  error). Admin tracking (`PolicyAckTracker`, the portal) cross-references
  the raw acknowledgment list against `GET /employees` client-side to show
  who has/hasn't acknowledged — the SAME "no dedicated picker/join
  endpoint" posture [frontend-admin-console.md](./frontend-admin-console.md)
  already documents for itself, not a new pattern.
- **RBAC**: `announcement.read`/`policy.read` (read + acknowledge — seeded
  onto every role including `EMPLOYEE`) vs. `announcement.manage`/
  `policy.manage` (publish, deactivate, view acknowledgment tracking —
  `TENANT_ADMIN`/`HR_MANAGER` only).

## A real, general bug caught and fixed during this step

`@hrm/shared`'s `redactSensitiveFields` (the ONE audit-redaction function
every `AuditInterceptor`/`DomainEventAuditListener` write goes through —
see [audit-custom-fields.md](./audit-custom-fields.md)) walked ANY object
value — including a live `Prisma.Decimal` class instance — via
`Object.entries`/`Object.fromEntries`, reconstructing its internal digit
representation (`{s, e, d}`) instead of its actual value. For `Decimal`
specifically this isn't even valid JSON input to Prisma's own `Json`
column write (`Invalid value for argument`: — an audited `POST /expenses/
categories` with a `policyLimitAmount` crashed outright with a 500), and
for `Date` it silently mangled every timestamp into `{}` in every audited
`before`/`after` payload across the ENTIRE codebase — a pre-existing,
general defect this step's first Decimal-bearing audited route simply
happened to be the first to trip loudly. **The fix**: `redactRecursive`
now checks for a `toJSON()` method (present on both `Decimal` and `Date`,
absent on a plain `{...}` object) BEFORE walking an object's own
properties structurally, and recurses on `value.toJSON()`'s result instead
— the SAME protocol `JSON.stringify` itself already uses to get a value's
real serializable representation. Fixed in `packages/shared`, so every
OTHER audited route with a `Decimal`/`Date` field (Payroll's `PayrollRun`/
`PayrollRunLine`, ...) is retroactively correct too, not just this step's
own new routes — verified directly:
`packages/shared`'s own build plus the full 318-test backend suite and
68-test Playwright suite (including every pre-existing spec) all green
with this fix in place.

## Scope discipline — what this step did NOT touch

`apps/api/src/workflow/*` (used as-is — an expense claim's approval is a
plain `WorkflowTemplate`/`WorkflowInstance`, zero engine changes),
`apps/api/src/payroll/engine/*` and `apps/api/src/country-packs/rules-engine/*`
(the actual tax/statutory math — completely untouched; the reimbursement
hand-off is ORCHESTRATION only, see above), `apps/api/src/checklists/*`
(used as-is — the asset-return wiring lives in `OffboardingService`, never
in the generic checklist engine), `apps/api/src/auth/*`/RLS policy
definitions for every EXISTING table (untouched; every new table in this
step gets the identical `tenant_isolation` policy pattern). Two existing
files gained mechanical, additive lines only:
`notification-recipient-resolver.service.ts` (the `helpdesk.ticket_escalated`
case), `domain-event-audit.listener.ts`/`notification-dispatch.listener.ts`
(one `@OnEvent('helpdesk.*')` subscription each) — the same shape every
prior step's own new event namespace already required.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: no UI for creating/completing an `AssetMaintenanceRecord` (the
backend routes exist and are exercised only at the API level — the admin
console's asset row only ever DISPLAYS a maintenance count); no department
targeting picker for announcements (branch targeting only — `GET
/departments` doesn't exist anywhere in this API, the same gap
[frontend-admin-console.md](./frontend-admin-console.md) already documents
for every other department picker in this codebase); no draft/unpublished
state reachable from the portal for announcements/policies (the create
forms always `publish: true` immediately — the backend's `publish: false`

- separate `POST .../publish` path exists and is exercised only at the API
  level); ticket/helpdesk assignment reuses the employee picker pattern
  (`listEmployees()`, filtered to entries with a `userId`) rather than a
  dedicated "assignable users" endpoint, the same documented picker
  limitation as Asset Management above.

Verified end-to-end over real HTTP by
`apps/api/test/operations-modules.e2e-spec.ts` (17 tests: a small expense
claim needing only manager approval with the HR step SKIPPED and a large
one ADDING it via the real sandboxed condition evaluator; a policy-limit
violation rejected at submission; a real Payroll run merging an APPROVED
claim's amount straight onto net pay with a genuine Decimal multi-currency
rollup snapshot, marking the claim REIMBURSED; a receipt uploaded and
downloaded byte-for-byte; an asset registered, assigned, and returned; the
offboarding clearance checklist's real "asset return" step blocked while
an asset is outstanding and unblocked once returned; a helpdesk ticket
raised, commented on, and SLA-escalated with a real notification landing
for the resolved HR_MANAGER recipient; an announcement correctly targeted
to one branch and not another; a policy published, acknowledged, and
tracked per user; cross-tenant isolation via RLS across every new table)
plus `apps/portal/tests/operations-modules.spec.ts` (17 Playwright tests
over the real browser/API/Postgres/Redis/MinIO stack: the same core flows
proven through the actual UI — submitting/approving an expense claim via
the inline `WorkflowStatusPanel`/`/approvals` inbox, registering/assigning/
returning an asset, raising/commenting/assigning a helpdesk ticket,
publishing an announcement/policy and acknowledging it, RBAC-gated nav
visibility, and cross-tenant isolation). Two real bugs caught while
writing these tests, both fixed, worth recording: (1) the `redactRecursive`
Decimal/Date bug above; (2) a portal test doing TWO `login()` calls within
ONE `test()` (switching users mid-test) redirected `/login` back to
`/dashboard` mid-fill since the earlier session was still valid — the
EXACT "one login per test" lesson
[frontend-admin-console.md](./frontend-admin-console.md) already documents
for a related flakiness class, re-confirmed here; fixed by splitting each
multi-actor flow into separate sequential tests within one
`describe.serial` block, state threaded through closure `let`s exactly
like `payroll.spec.ts`'s own `runId`.

All existing tests continue to pass: `apps/api` at 318 (301 existing + 17
new), `apps/portal` at 68 Playwright tests (51 existing + 17 new). Full-repo
`pnpm build`/`pnpm lint` green across all eight package tasks.
