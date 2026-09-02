# Admin/HR Console (Payroll · Performance · Recruitment/Onboarding/Offboarding UI)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 2.4 (renumbered from an earlier draft "3.1" — this UI-catch-up
step belongs to Phase 2's own closing note, not Phase 3; Phase 3's real first
slice is [`operations-modules.md`](./operations-modules.md)) — `apps/portal`.
Phase 2 shipped
Payroll (2.1), Performance (2.2), and Recruitment/Onboarding/Offboarding
(2.3) API-only; this step is the "UI catches up" pass 2.3's own closing note
anticipated, built the same way 1.4 caught the portal up on Leave/
Attendance a phase earlier: a pure CONSUMPTION layer over already-shipped,
already-tested APIs. It builds directly on
[frontend-ess-mss.md](./frontend-ess-mss.md)'s foundations — auth/tenant
resolution, the session-aware i18n/RTL integration, `useAsync`, the
`components/ui/*` design system, the field-omission pattern — with **zero
changes to that layer**. Nothing about RLS, auth core, the workflow engine,
or any Phase 2 module's own business logic changed for this step; see
"Scope discipline" below for the one narrow, deliberate exception.

## The one additive backend endpoint

**`GET /payroll/runs?branchId=&periodYear=&periodMonth=`**
(`apps/api/src/payroll/runs/payroll-run.service.ts`'s new `findMany`,
`apps/api/src/payroll/payroll.controller.ts`'s new `@Get('runs')` route).
Every OTHER list route across Payroll/Performance/Recruitment/Onboarding/
Offboarding already existed — this was the one genuine gap: a `PayrollRun`
could previously only be fetched by id, with no way to discover which ids
exist. Gated identically to every other route on this controller
(`FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL` + `PERMISSIONS.PAYROLL_RUN` +
`PermissionSerializerInterceptor`, so `salary.view` field-omission applies
here too), reuses the file's own `toRunDto` with no `lines` argument (the
same line-less shape `POST /payroll/runs` already returns), and follows the
same branch-scoping convention every read in this codebase already
holds itself to: an out-of-scope `branchId` filter returns `[]`, never a 403. Covered by four new cases in `apps/api/test/payroll.e2e-spec.ts`
(ordering, filter narrowing, out-of-scope-branch empty result, and
`salary.view` field-omission on the LIST route specifically, since gating
was previously only proven on the by-id route).

No other backend gap needed a new endpoint: employee/branch pickers reuse
the existing `GET /employees`/`GET /tenancy/branches`; an interviewer
picker reuses `GET /employees` filtered to entries with a non-null
`userId`, submitting that `userId` (interviewers are `User` ids, not
`Employee` ids). Two documented, deliberate limitations instead of two more
endpoints — see "Known gaps" below.

## `lib/api/` — five new files, the identical `leave.ts`/`attendance.ts` shape

`apps/portal/src/lib/api/{payroll,performance,recruitment,onboarding,offboarding}.ts`
each follow 1.4's established convention exactly: plain exported async
functions, one per backend route, `apiFetch<T>` underneath, param objects
defaulting to `{}`, request `Input` types defined inline in the same file.
`lib/api/types.ts` gained every response shape touched, hand-mirrored (not
imported from `@hrm/shared`, per that file's own established duplication
convention) — `@RequiresPermission`-gated Payroll fields (`totalGross`,
`grossPay`, ...) are marked optional with the same doc-comment convention
`Employee.compensation?` already established (`present only for a caller
with salary.view — omitted, not null, otherwise; always check 'field' in
object rather than truthiness`). Money is always a `string` on Payroll DTOs
(mirroring the backend's `Decimal#toString()`); `Offer.proposedSalary` is a
plain `number` (genuinely ungated in the API, unlike Payroll's amounts).
`lib/api/workflow.ts` needed **zero changes** — it was already fully
generic.

### A real, honest caveat carried over from the backend as-is: `AppraisalDetail.employee`

`GET /performance/appraisals/:id` returns the raw, un-redacted Prisma
`Appraisal` row with `employee: true` included — no
`PermissionSerializerInterceptor` on that route. The portal's
`AppraisalDetail.employee` type is deliberately narrowed to identity-only
fields (`id, employeeCode, firstName, lastName, branchId`) so nothing in
the UI is ever tempted to read compensation/statutory data off it. This is
a pre-existing backend characteristic (out of scope to "fix" from the
frontend per this step's brief), documented here so a future contributor
doesn't widen that type back out without re-checking the backend route.

## `apiFetchBlob` — the one binary-download seam `apiFetch` couldn't cover

`apiFetch<T>`'s `request()` always does `res.text()` → `JSON.parse` — this
corrupts/throws on Payroll's three `StreamableFile` routes... actually two:
payslip PDF and bank-export CSV (the third binary-ish route, a checklist
task's uploaded document, has no download counterpart at all — see "Known
gaps"). `apps/portal/src/lib/api/client.ts` gained `apiFetchBlob(path,
{ method?, query? })`, sharing the SAME tenant-header/auth/single-shared-
401-refresh-retry logic `request()` already owns (extracted into a shared
`doFetch()` both call), but finishing with `res.blob()` + `Content-
Disposition` filename parsing instead of JSON parsing. `apps/portal/src/lib/download.ts`'s
`triggerBrowserDownload(blob, filename)` (object URL + a synthetic `<a
download>` click) is the one new browser-side primitive both
`downloadPayslip` and `bankExportPayrollRun` call. **A real bug this
surfaced**: `bankExportPayrollRun` calls `POST /payroll/runs/:id/bank-
export`, but `apiFetchBlob` was initially hardcoded to `GET` — caught via a
live page snapshot showing `Cannot GET /payroll/runs/.../bank-export`,
fixed by adding the `method` parameter.

## `WorkflowStatusPanel` — one shared sign-off component, five call sites

`apps/portal/src/components/workflow/WorkflowStatusPanel.tsx` —
`{ workflowInstanceId: string | null }`. Renders nothing if `null` (the
module hasn't submitted for approval yet — its own status field is the
source of truth until then). Otherwise fetches `GET /workflow/instances/:id`
and renders the instance's `StatusBadge`, an ordered list of steps each
with their own `StatusBadge`, and — only when the caller is eligible on
the current `ACTIVE` step (`eligibleApproverIds`/`delegatedToUserId`, or
holds `workflow.manage`) — an approve/reject/comment form. That form
(`WorkflowActionForm.tsx`) was EXTRACTED from `ApprovalCard.tsx` (the 1.4
approvals-inbox card), which now renders `<WorkflowActionForm>` itself — a
pure, behavior-preserving refactor (verified against `mss.spec.ts`'s
existing `approve-button`/`reject-button` test-id contract) that removes
what would otherwise have been a fifth copy of the same approve/reject/
comment logic. Dropped inline into the Payroll run detail page, the
Performance appraisal detail page, Recruitment's requisition/offer rows
(as an expandable `<details>` panel, not a separate route — "functional
over fancy"), and the Offboarding process detail — one component, five
call sites, zero copies.

**A 403 (no standing on that instance — not the requester, not an eligible
approver on any step, not `workflow.manage`) is caught locally and
degrades to `<Alert tone="info">{t('workflow.noAccess')}</Alert>`**, via
the fetcher itself catching the `ApiError` into a `'forbidden'` sentinel
BEFORE it reaches `useAsync` — `useAsync.ts` itself needed zero changes,
so this pattern carries zero risk to any of the dozen other screens already
built on it. This mattered in practice: a `MANAGER`-role approver resolved
by an `OffboardingProcess` template's `{type:'MANAGER'}` rule does NOT hold
`offboarding.manage`, so they cannot reach `GET /offboarding/processes/:id`
at all — they approve via the pre-existing, entity-type-agnostic
`/approvals` inbox instead (see below), never via the process detail
page's own panel. This is exactly the kind of case the plan anticipated:
check each entity's real read-permission gating before assuming the
inline panel is reachable for every possible approver.

## The existing approvals inbox — zero code changes, five new entity types for free

`apps/portal/src/app/(app)/approvals/page.tsx`, `lib/api/pending-
approvals.ts`, and `ApprovalCard.tsx` needed **no changes** to start
surfacing `PayrollRun`/`PerformanceAppraisal`/`JobRequisition`/`Offer`/
`OffboardingProcess` approvals — `getMyPendingApprovals`/
`getWorkflowInstance` are entity-type-agnostic by construction, and
`ApprovalCard`'s `SnapshotSummary` already degraded gracefully (returns
`null` for an unhandled `entityType`, employee-name resolution falls back
to the raw `requesterId`). Only five new `approvals.entity.*` i18n keys
were needed for a proper label instead of a raw key fallback. This is THE
RULE's payoff restated for the sixth time in this codebase (Leave,
Attendance, Payroll, Performance, Recruitment/Offer/Requisition,
Offboarding all now route through the identical generic engine): a whole
UI surface arrives for free by consuming the workflow engine instead of
building a bespoke one.

## Pages (`app/(app)/`) — flat, functional over fancy

```
/payroll                      runs list (branch filter) + create modal
/payroll/[id]                 run detail: totals (field-omission aware),
                               lines table, calculate/submit/finalize/
                               mark-paid/bank-export actions (permission+
                               status gated), per-line payslip download,
                               <WorkflowStatusPanel>

/performance                   cycles list + create modal + open/close
/performance/[id]               cycle detail: appraisal roster + calibration
                                (branch-filtered table + recompute trigger)
/performance/appraisals/[id]    assignments, reviews, peer-assign,
                                submit-for-approval, <WorkflowStatusPanel>
/performance/my-reviews         pending review assignments + submit form

/recruitment                    tab 1: requisitions (create/submit/close,
                                inline expandable WorkflowStatusPanel per
                                row); tab 2: postings (create/publish/close)
/recruitment/candidates         pipeline board, 6 columns by ApplicationStage,
                                a per-card <Select> moves stage (no drag-
                                and-drop — "functional over fancy")
/recruitment/candidates/[id]    candidate detail: applications, interviews
                                (schedule + list), scorecards
/recruitment/offers             list + create/submit/accept/decline,
                                inline WorkflowStatusPanel per row
/recruitment/onboarding         processes list + create-employee form +
                                ungated "my tasks" section
/recruitment/offboarding        initiate form + processes list + complete
                                action (links straight to the resulting
                                settlementPayrollRunId's /payroll/[id]) +
                                ungated "my tasks" section
```

Every page follows `leave/page.tsx`'s exact shape: client component,
`useI18n()`/`useSession()`/`useAuth()` at the top, one `useAsync` per data
need (guarded on permission — `canX ? fetchX() : Promise.resolve(fallback)`),
`<PageSpinner/>`/`<EmptyState/>`, hand-rolled `<table>` with logical
Tailwind classes + `data-testid`s, a `<Modal>` + local-state form component
for creates, and an `<Alert tone="info">` fallback for a caller with no
relevant permission (the `analytics/page.tsx` pattern). A permission-gated
action button is `{can(PERMISSIONS.X) && <Button>}`, never a disabled
button shown to everyone — RBAC hides the action, it doesn't just block it.
An async BullMQ-driven action (payroll's Calculate, performance's
calibration Recompute) shows a transient "processing" note and a manual
Refresh button rather than client-side polling — deliberately, per
"functional over fancy."

`Badge.tsx`'s `STATUS_TONE` map gained additive entries for every new
status vocabulary (`DRAFT`, `CALCULATED`, `FINALIZED`, `PAID`, `IN_STEP`,
`ESCALATED`, `IN_PROGRESS`, `PENDING_SIGNOFF`, `COMPLETED`, `SUBMITTED`,
`PENDING_APPROVAL`, `PUBLISHED`, `APPLIED`, `SCREEN`, `INTERVIEW`, `OFFER`,
`HIRED`, `ACCEPTED`, `DECLINED`, ...) — several needed statuses already
had a usable tone by lucky overlap (`PENDING`, `APPROVED`, `REJECTED`,
`OPEN`, `CLOSED`, `CANCELED`); none of the existing entries were touched.

### Sidebar

`components/layout/Sidebar.tsx` gained a third nav section (`adminItems`,
heading `t('nav.admin')`, rendered only when non-empty) alongside the
existing `essItems`/`mssItems` — identical shape, one `if (can(...))
adminItems.push(...)` per route: Payroll (`payroll.run` or
`payroll.approve`), Performance (`performance.read` or
`performance.manage`), Recruitment (`recruitment.read` or
`recruitment.manage`), Onboarding (`onboarding.manage`), Offboarding
(`offboarding.manage`). `my-reviews`/`my-tasks` are reached from within
their parent pages, not given their own nav entries — a plain `EMPLOYEE`
who holds `performance.review` but not `performance.read` still reaches
`/performance` itself (broadly seeded on `performance.read` too, so this
is moot in practice) and finds "my reviews" there.

## Known, documented gaps (inherited or deliberately not worked around)

- **No department/designation pickers anywhere.** `GET /departments`/
  `GET /designations` don't exist anywhere in this API. Every field that
  references them (`JobRequisition.departmentId`, `Offer.departmentId`,
  onboarding's `departmentId`/`designationId`) is optional in its backend
  schema, so the v1 forms simply omit those pickers rather than adding two
  more endpoints for this step alone — a documented limitation, not a
  silently dropped feature.
- **No download route for a candidate's resume or a checklist task's
  uploaded document** — only the storage key is exposed on the JSON row
  (`Candidate.resumeStorageKey`, `ChecklistTaskInstance.documentStorageKey`).
  Unlike payslips/bank-exports, neither has a `GET .../download`
  counterpart in the shipped Phase 2 surface, so the portal doesn't attempt
  to preview or download either — a real, inherited gap, not something
  this step could paper over from the frontend alone.
- **`AppraisalDetail.employee`** is a raw, unredacted embed (see above) —
  display identity fields only, never anything else.
- **No `EmployeePicker` abstraction** was extracted — interviewer/manager/
  peer-reviewer/offboarding-target pickers each independently render a
  `listEmployees()`-backed `<select>`/checkbox list inline. Worth
  promoting into one shared component if a fourth or fifth near-identical
  use shows up; three uses didn't clear that bar for this step.

## Testing — real browser, real infra, zero mocks, three new spec files

`payroll.spec.ts` (10 tests), `performance.spec.ts` (10 tests),
`recruitment.spec.ts` (14 tests) — `apps/portal/tests` grows from 17 to 51
Playwright tests, all against the SAME real Postgres/Redis/BullMQ/MinIO
stack every existing spec already runs against. `global-setup.ts`/
`fixtures.ts` gained, additively, on top of the existing ESS/MSS/analytics
fixtures: `FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL` enabled for tenant A (the
fixture tenant defaults to `STARTER`, which doesn't include this
ENTERPRISE-only flag by default); a custom role holding `payroll.run` but
NOT `salary.view` (no seeded system role has that exact combination, and
it's needed for a clean field-omission proof isolated from `MANAGER`'s
other differences); `WorkflowTemplate`s for `PayrollRun`/
`PerformanceAppraisal`/`JobRequisition`/`Offer`/`OffboardingProcess` (a
`{type:'ROLE', roleName:'TENANT_ADMIN'}` rule for the HR/admin-submitted
entities that have no org-chart requester relationship — `PayrollRun`,
`JobRequisition`, `Offer` — versus `{type:'MANAGER'}` for
`PerformanceAppraisal`/`OffboardingProcess`, whose requester really is the
appraised/departing employee, per 2.2/2.3's own documented reuse of that
resolver); a seeded `Candidate`+`Application` (the public careers API is
out of this UI's scope, so there's no UI-reachable way to create one) and
`AppraisalRatingDistributionSnapshot` rows (proving the calibration UI
renders precomputed rollups without re-driving a full appraisal-to-
`COMPLETED` flow just to produce one, mirroring `analytics.spec.ts`'s own
"prove rendering, not recomputation" posture).

### Real bugs/races caught and fixed during this step's own test-writing — worth recording

- **`apiFetchBlob` hardcoded to `GET`** (see above) — bank export is a
  `POST`. Caught by the bank-export test itself failing against the real
  API, not assumed.
- **A checklist-completion race in `MyTasksList.tsx`'s test usage**: its
  `{loading ? <Spinner/> : <ul>...}` conditional means completing one task
  (triggering the list's own `reload()`) briefly unmounts and remounts
  EVERY row, including a second task's file `<input>`, while its
  `useState`-held `files` map (separate state, survives the swap) is fine
  but the native, uncontrolled file input's OWN selected-file state is
  NOT — it's a fresh DOM node after the remount. The fix is procedural, in
  the TEST, not the component: wait for the first task's row to actually
  disappear (`toHaveCount(1)`) before touching the second task's file
  input, exactly mirroring a wait `onboarding`'s own equivalent test
  already used successfully — this is a real, generally-applicable lesson
  for any future test driving two sequential actions against the same
  `useAsync`-backed list.
- **Stacking multiple full-page `page.goto()` reloads within ONE login
  session can race 0.4's refresh-token rotation** (each reload wipes the
  in-memory access token, forcing a fresh `POST /auth/refresh`, which
  rotates the refresh token) **and trip the reuse-detection guard**,
  logging the whole session out mid-test. The fix: split a test that was
  doing three `page.goto()`s in one login into three separate tests, each
  with its own fresh login — the SAME "one login per test" lesson 2.2's
  own test-writing already surfaced for a related flakiness class.
- **The fixture tenant's `STARTER`-tier per-tenant request-volume quota
  (0.10's `TenantRateLimitService`, `DEFAULT_RATE_LIMITS.STARTER`: 200
  requests/60s) is a REAL resilience control, and this suite's own volume
  (many full-page reloads × several concurrent fetches each, plus polling
  loops) legitimately exceeds it** — surfacing as a generic "Too many
  attempts" 429 that has nothing to do with login-attempt counting despite
  an identical-looking error message (`TooManyAttemptsException`'s message
  is shared across every `RateLimiterService.consume()` caller, login
  included). The fix: `global-setup.ts` now creates both fixture tenants
  with `edition: 'ENTERPRISE'` (2000 req/60s) — a SEPARATE mechanism from
  the `multi_country_payroll` feature-flag override already needed for
  Payroll, and the correct fix for a fixture tenant that legitimately
  exercises this much traffic, the same way a real high-volume tenant
  would need the matching tier.

Full-repo `pnpm build`/`pnpm lint` green across all eight package tasks;
`apps/api`'s full suite (301 tests: 297 existing + 4 new for `GET
/payroll/runs`) green; `apps/portal`'s full Playwright suite (51 tests: 17
existing + 34 new across the three files above) green, including every
pre-existing spec (`auth`, `ess`, `mss`, `rbac`, `rtl`, `tenant-isolation`,
`analytics`) with zero regressions from the Sidebar/`Badge`/
`ApprovalCard`/`messages.ts`/`global-setup.ts` edits this step made.
