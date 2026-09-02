# Learning & Development (LMS)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.2 (Phase 3's second slice) — `packages/db`, `packages/shared`,
`apps/api/src/lms`, `apps/portal`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)
(the "3.2 Learning & Development" entry) for the full file list and
verification notes. A THIN module, the same posture
[`operations-modules.md`](./operations-modules.md) already established for
3.1: content lives in 1.1's `StorageService`/MinIO, expiry reminders reuse
0.8's notification hub, and BOTH of this step's own scheduled jobs reuse
1.5's `AnalyticsRollupService` scheduled-BullMQ pattern verbatim. Quizzes and
required-training rules are tenant-authored DATA — questions, pass marks,
and eligibility rules — never hardcoded scoring or eligibility logic, the
same "config as data" posture Country Packs/workflow approver rules/custom
fields already take throughout this codebase.

## Courses, content, and modules

- **`Course`** (`DRAFT` → `PUBLISHED` → `ARCHIVED`) belongs to an optional
  `CourseCategory` and carries `isMandatory` (informational — no enforcement
  logic reads it, it's for UI/reporting emphasis only) and `validityMonths`
  (`null` = a certification for this course never expires). `CourseService.
list` forces `status: 'PUBLISHED'` for any caller without `lms.author` —
  the same "RBAC gates the feature, the service layer gates the row"
  two-layer shape this codebase takes throughout (see
  [auth-rbac.md](./auth-rbac.md)); an author sees every status. `publish`
  requires at least one content item and only transitions from `DRAFT` —
  a real control point, not a formality.
- **`CourseContentItem`** — `moduleName` (a plain, informal string grouping,
  not its own table) plus `orderIndex` sequence items within a course; this
  step's brief only asked for "ordering/modules", and a full `CourseModule`
  entity would be over-engineering for what's otherwise a flat ordered
  list. `type` is `VIDEO`/`DOCUMENT`/`LINK` — exactly one of `storageKey`
  (an uploaded VIDEO/DOCUMENT via 1.1's `StorageService`/MinIO, the SAME
  `expenses/`/`helpdesk/` key-partitioning convention, here
  `lms/<tenantId>/<courseId>/<itemId>-...`) or `externalUrl` (a LINK item)
  is ever populated — enforced at the service layer
  (`CourseService.setContentItemStorageKey` rejects a LINK item;
  `createContentItemSchema`'s `.refine()` requires `externalUrl` when
  `type === 'LINK'`).

## Enrollment, progress, and completion — the one function that decides

- **Self-enroll vs. admin/manager-assigned — two distinct methods, not one
  optional `employeeId` field.** `EnrollmentService.enroll` (self only,
  `lms.enroll`) and `.assign` (`lms.assign`, takes `employeeId` + an
  optional `dueDate` and emits `lms.course_assigned`) — the SAME "who is
  this FOR" split `ExpenseClaimService.resolveTargetEmployee` already
  establishes, expressed here as two routes because assignment genuinely
  needs its own fields and its own notification, not because the
  underlying `Enrollment` row differs (`source: SELF | ASSIGNED` is the
  only distinguishing column). Both require the course to be `PUBLISHED`
  and reject a duplicate ACTIVE (`ENROLLED`/`IN_PROGRESS`) enrollment for
  the same course+employee — `409`.
- **Deliberately NO `@@unique([tenantId, courseId, employeeId])` on
  `Enrollment`** — see the schema's own doc comment. A course
  certification is RENEWED by _retaking_ the course (below), which means a
  SECOND `Enrollment` row for the same (course, employee) pair is a
  legitimate, expected case once the first one is `COMPLETED` — a DB
  unique constraint can't express "unique only among ACTIVE rows" cleanly,
  so "already actively enrolled" is an application-level check
  (`assertNoActiveEnrollment`) instead. The DB allows it; the service layer
  decides what's meaningful — the same posture `AssetAssignment`'s own
  append-only history already takes.
- **`EnrollmentService.recomputeCompletion` is THE ONE place completion is
  decided** — called after every content-progress mark
  (`markContentComplete`) AND every quiz-attempt submission
  (`QuizService.submitAttempt`), so completion can never be computed two
  different ways. A course completes once every `CourseContentItem` has a
  `COMPLETED` `ContentProgress` row for this enrollment AND — only if the
  course has a `Quiz` with `isRequired: true` — the employee holds a
  passing `QuizAttempt` for it. Idempotent: a no-op against an
  already-`COMPLETED` enrollment (never issues a second certification for
  the same completion).

## Quizzes — configurable as data, never a hardcoded scoring engine

- One `Quiz` per course (`@@unique([tenantId, courseId])`), single-
  correct-answer multiple choice only — the thin scope this step's brief
  actually asks for ("configurable as data — questions, pass mark"), not a
  general-purpose exam engine. `QuizQuestion.options` is a plain `[{key,
text}]` JSON array (the same "JSON column has no schema-level guarantee
  of its own, validated at the service layer" posture Country Pack config/
  custom fields already take); `correctOptionKey` must match one of
  `options[].key`, checked by `createQuizQuestionSchema`'s `.refine()` at
  write time.
- **`correctOptionKey` is stripped before a question ever reaches a caller
  taking the quiz** — `QuizService.getForTaking` destructures it out of
  every question before returning (`GET /lms/courses/:id/quiz`); the full
  authored shape (including the answer key, for review) is only ever
  returned by the separate admin route (`GET /lms/courses/:id/quiz/admin`,
  `lms.author`). A plain, manual field omission — this module has no
  salary-like field-gating precedent worth reusing `@RequiresPermission()`/
  `PermissionSerializerInterceptor` for a single field on one DTO shape.
- `QuizAttempt` is APPEND-ONLY per submission (an employee may retake a
  quiz — the same "history, not overwrite" posture `AssetAssignment`
  already takes), scored server-side by summing `points` for every
  question where the submitted answer matches `correctOptionKey`,
  `scorePercent = round(earned/total * 100)`, `passed = scorePercent >=
quiz.passMarkPercent`.

## Certifications — expiry and renewal

- Issued by `CertificationService.issueForCompletedEnrollment`, called
  ONLY from `recomputeCompletion` once an enrollment reaches `COMPLETED`.
  `expiresAt = issuedAt + Course.validityMonths` (`null` stays `null` —
  never expires).
- **Renewal means "retake the course" — never a separate "renew without
  retaking" code path.** If an ACTIVE certification for the SAME
  course+employee already exists when a new one is issued, the OLD row
  flips to `RENEWED` and the NEW row's `renewedFromCertificationId` links
  back to it (a composite-FK self-relation, the same shape
  `Employee.manager`/`Branch.parentBranch` already use). This is why
  `Enrollment` deliberately has no unique-per-course-per-employee
  constraint (above) — a second enrollment in the same course, once the
  first is `COMPLETED`, is the ONLY renewal mechanism this step builds,
  and it needed the schema to allow it.
- **`lastReminderBucket`/`lastReminderSentAt` are the scheduled expiry-
  reminder job's OWN idempotency bookkeeping** — see below.

## Required training — config as data, and the two-tier compliance read

- **`RequiredTraining`**: `roleId`/`branchId` are BOTH independently
  nullable and "unrestricted when null" — the same "absence means
  unrestricted" posture `Announcement.targetBranchIds`/branch-scoping's
  own `allowedBranchIds: null` already take elsewhere in this codebase,
  just expressed as two separate nullable FK columns here since a rule
  needs to independently vary by either dimension (or neither, for a
  tenant-wide mandate). Deliberately NO unique constraint spanning the
  nullable columns — the same NULL-in-unique-index gotcha
  [analytics-dashboard.md](./analytics-dashboard.md) already documents for
  its own rollup tables; a duplicate rule row is harmless, since matching
  is an OR across every applicable row, not a keyed lookup.
  `resolveRequiredCourseIdsByEmployee` (`lms-compliance.util.ts`, pure and
  unit-tested indirectly via `determineComplianceBucket`) does the actual
  branch/role matching, shared verbatim between the live drill-down and
  the rollup job so the two can never disagree about who's required to
  hold what.
- **No role picker in the portal's required-training form** — this
  codebase has no `GET /roles` listing endpoint anywhere (0.4's own
  documented gap: "no role-management endpoint... only enforcement +
  seeding"), the same "documented, not silently accepted" posture
  [frontend-admin-console.md](./frontend-admin-console.md) already takes
  for its own missing department pickers. The form only offers branch
  targeting; a role-scoped rule can still be created directly via the
  owner `prisma` client (fixtures/tests) exactly like every workflow
  template in this codebase already is.
- **The two-tier compliance read — a rollup for the DASHBOARD number, a
  bounded live read for the DRILL-DOWN list.** `TrainingComplianceDailySnapshot`
  (one row per tenant/date/branch/department/course, the SAME small-
  dimension point-in-time-cross-section discipline
  [analytics-dashboard.md](./analytics-dashboard.md) established) is what
  `GET /lms/compliance/dashboard` reads — NEVER a live aggregate over
  `Enrollment`/`Certification`/`RequiredTraining` at 20M-employee scale.
  "Who, exactly, is missing/expiring" (`GET /lms/compliance/gaps`,
  `LmsComplianceService.listGaps`) is a SEPARATE, bounded, branch-filtered
  live read (required `branchId`, an indexed, small-cardinality query) —
  the same two-tier split `GET /payroll/runs` already establishes for its
  own operational list next to Payroll's rollup-free-by-design run
  history. `determineComplianceBucket` (COMPLIANT/EXPIRING(≤30d)/EXPIRED/
  MISSING) is the ONE classification function both paths call — see
  `lms-compliance.util.ts`.

## Two independent scheduled BullMQ jobs

Both are the IDENTICAL "register one repeatable job idempotently on every
app boot; fan out one per-tenant job from an owner-client tenant listing"
shape `AnalyticsRollupService` established in 1.5 (see
[analytics-dashboard.md](./analytics-dashboard.md) → "The first real
scheduled job in this codebase") — reused verbatim for a SECOND,
independent schedule, since the two run on different cadences and neither
should block the other:

- **`LmsRollupService`/`LmsRollupProcessor`** (daily, `0 3 * * *`) —
  computes `CourseCompletionDailySnapshot` (group `Enrollment` by branch/
  department/course, count each status) and
  `TrainingComplianceDailySnapshot` (resolve every employee's required
  courses via `RequiredTraining`, classify each pair via
  `determineComplianceBucket`, group-count) — DELETE-then-`createMany` per
  `(tenantId, date)`, the same nullable-`departmentId`-breaks-upsert fix
  [analytics-dashboard.md](./analytics-dashboard.md) documents for itself.
  `POST /lms/rollup/run` is the manual backfill/test lever, same shape
  `POST /analytics/rollup/run` already establishes.
- **`CertificationExpiryService`/`CertificationExpiryProcessor`** (daily,
  `0 4 * * *`) — sweeps every `ACTIVE` certification with a non-null
  `expiresAt`, classifies it via the SAME `determineComplianceBucket`
  (`EXPIRING`/`EXPIRED`/`COMPLIANT`), and — **IDEMPOTENT BY CONSTRUCTION**:
  compares the freshly computed bucket against `Certification.
lastReminderBucket`; a re-run that recomputes the SAME bucket sends
  NOTHING twice. This is DB-native idempotency, not 0.10's Redis
  `IdempotencyService` — a full recompute from source data (the
  certification's own `expiresAt`) is naturally idempotent per row, the
  same argument `AttendanceDailySummary`'s own doc comment already makes
  for itself (see [attendance.md](./attendance.md)), applied per-row here
  instead of via delete+recreate. On a genuine bucket CHANGE, emits
  `lms.certification_expiring` or `lms.certification_expired` (two
  distinct mapped `NotificationEventType`s, since the copy a learner needs
  to see genuinely differs — "renew soon" vs. "this has lapsed") with the
  employee's `userId` directly on the payload (no recipient-resolution DB
  query needed, the SAME shape `checklist.task_assigned`'s
  `assigneeUserId` already uses) and, on `EXPIRED`, also flips
  `Certification.status`. `POST /lms/certifications/expiry-sweep/run` is
  its own manual backfill/test lever.

## RBAC

Five new permissions: `lms.read`/`lms.enroll` (browse the catalog, take a
course, view your own certifications — seeded onto every system role
including `EMPLOYEE`), `lms.assign` (assign training to another employee —
additionally seeded onto `MANAGER`), `lms.author` (create/edit courses and
quizzes), `lms.manage` (certifications list, required-training rules,
compliance dashboard/gaps) — the latter two `HR_MANAGER`/`TENANT_ADMIN`
only. `GET /lms/enrollments` (the admin/manager listing route) is gated on
`lms.read` alone; the SERVICE layer narrows an unprivileged caller (holds
`lms.assign` but not `lms.manage`) to only the enrollments THEY assigned
(`enrolledByUserId === callerUserId`) — the same "gate the feature broadly,
narrow the row in the service" shape `HelpdeskController.list` already
establishes for its own `helpdesk.manage`-narrowed ticket list.

## Portal (`apps/portal`)

- **ESS**: `/learning` (catalog + my enrollments' due dates + my
  certifications) and `/learning/[id]` (enroll, mark content complete,
  take the quiz via `<QuizTaker>`, see the pass/fail result). Content
  files download via `apiFetchBlob`/`triggerBrowserDownload`, the SAME
  seam `downloadTicketAttachment`/`downloadPayslip` already establish;
  LINK items open in a new tab.
- **Admin**: `/learning/admin` (categories, courses, and — inside each
  expandable `<course-admin-row>` — content-item authoring + file upload,
  the quiz editor, and the assign-training form, all in one row, "one
  component, no modal-per-action" the same functional-over-fancy posture
  `TicketRow` already takes for its own comments/attachments/assignment)
  and `/learning/admin/compliance` (required-training rules, the
  compliance dashboard, and the gaps drill-down, branch-selected).
- **A real UI race caught and fixed while writing the Playwright spec,
  worth recording generally**: a PASSING quiz attempt flips the
  enrollment to `COMPLETED` server-side; the course-detail page's own
  `reloadEnrollments()` (called from `QuizTaker`'s `onSubmitted`) picks
  that up and, because the Quiz card was conditionally rendered on
  `enrollment.status !== 'COMPLETED'`, UNMOUNTED THE CARD (and the
  "Passed" result it was showing) the instant the reload landed — often
  before a human (or the test) could ever read it. Fixed with a small
  local `quizJustCompleted` flag in the page component, set `true` inside
  the SAME `onSubmitted` callback when `attempt.passed`, which keeps the
  card (and its result) mounted for the rest of that page view regardless
  of what the reloaded enrollment status says. A general lesson for any
  future "an action's own side effect removes the UI element showing that
  action's result" pattern — verified the fix by re-running
  `apps/portal/tests/lms.spec.ts`'s completion test, which failed
  reproducibly before the fix (timeout waiting for the result alert) and
  passed cleanly after.
- `Sidebar` gained `nav.learning` (ESS, unconditional) and
  `nav.learningAdmin` (gated on `lms.author || lms.manage`); `Badge`'s
  `STATUS_TONE` gained additive entries only (`ENROLLED`, `RENEWED`,
  `EXPIRING`, `MISSING`, `ARCHIVED`).

## Scope discipline — what this step did NOT touch

`apps/api/src/workflow/*` (untouched — course assignment/completion is
direct, no approval step; a genuinely APPROVED training request was not
part of this step's brief), `apps/api/src/payroll/*`/`apps/api/src/
country-packs/*` (untouched — no payroll/statutory interaction),
`apps/api/src/checklists/*` (untouched), `packages/shared`'s audit
redaction pattern (untouched — no salary-like sensitive field exists on
any LMS DTO, so `REDACTED_KEY_PATTERN` needed no new entries). Two
existing files gained mechanical, additive lines only:
`notification-recipient-resolver.service.ts` (three `lms.*` cases, all
direct-payload-field resolution, no DB query needed),
`domain-event-audit.listener.ts`/`notification-dispatch.listener.ts` (one
`@OnEvent('lms.*')` subscription each) — the same shape every prior step's
own new event namespace already required.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: no role picker for required-training rules (see above — this
codebase has no role-listing endpoint anywhere yet); "training calendar"
is a derived read (`GET /lms/calendar`, merging `Enrollment.dueDate` and
`Certification.expiresAt` within a date range) rather than its own stored
calendar-event concept — the task's own wording links it directly to
required-training, and nothing in this step's test list asked for a
richer scheduling model; `Course.isMandatory` is informational only — no
route enforces "every employee must complete a mandatory course," that
enforcement concept IS `RequiredTraining` (a mandatory course still needs
an explicit rule to actually generate a compliance obligation); a
`Certification`'s `renewedFrom` chain has no dedicated "history" read in
the portal (the backend `renewals`/`renewedFrom` relations exist and are
exercised only at the API/DB level).

Verified end-to-end over real HTTP by `apps/api/test/lms.e2e-spec.ts` (15
tests: course authoring RBAC and DRAFT-invisible-to-catalog; publish
rejected with zero content items; a content file uploaded and downloaded
byte-for-byte; self-enrollment and a duplicate-active-enrollment 409; the
quiz served for taking never including the answer key; completing every
content item alone NOT completing a quiz-gated course; a failing attempt
leaving the enrollment open with no certification; a passing attempt
completing the course and issuing a certification with the correct
validity window; admin assignment triggering a real notification, visible
on the training calendar, with a duplicate-assignment 409; the live gaps
drill-down AND the real scheduled rollup job populating the compliance
dashboard; the certification-expiry sweep's idempotency across two runs
and its EXPIRING → EXPIRED transition with a distinct second notification;
cross-tenant isolation via RLS) plus
`apps/api/src/lms/rollup/lms-rollup.util.spec.ts` (10 pure-function tests:
completion/compliance row grouping, and `determineComplianceBucket`'s
every branch) plus `apps/portal/tests/lms.spec.ts` (8 Playwright tests
over the real browser/API/Postgres/Redis/MinIO stack: authoring a course
with content + a quiz + publishing it; assigning training; the full ESS
enroll → complete content → pass the quiz → certification flow through
the real UI; the compliance gaps drill-down; nav visibility RBAC;
cross-tenant isolation).

All existing tests continue to pass: `apps/api` at 344 (318 existing + 15
e2e + 10 rollup-util new — 1 pre-existing suite's count already included
in the 318 baseline), `apps/portal` at 76 Playwright tests (68 existing +
8 new). Full-repo `pnpm build`/`pnpm lint` green across every workspace
task.
