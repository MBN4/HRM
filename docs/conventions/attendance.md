# Attendance & time-tracking

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 1.3 (Phase 1) — `packages/db`, `packages/shared`,
`apps/api/src/attendance`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"1.3 attendance & time-tracking module" entry) for the full file list and
verification notes. This is the first HIGH-VOLUME module in this codebase —
every employee generates a row here daily — so it is designed
partition-ready and timezone-correct from day one, consuming rather than
reimplementing: Country Packs (0.5) for weekend/holiday/overtime rules, the
Employee/manager relation (1.1) for approver resolution, the workflow engine
(0.7) for regularization approval, and the 0.8 BullMQ pattern for the
summary-computation job.

## The clock model

- **One row per SHIFT (clock-in through clock-out), not one row per
  punch.** `AttendanceRecord.status` is `OPEN` (clocked in, not yet out) or
  `CLOSED`. A clock-out never creates a new row — it finds the caller's own
  `OPEN` record (`employeeId` + `status: OPEN`) and closes it. "At most one
  open record per employee" is enforced at the APPLICATION layer
  (`AttendanceClockService`), not a DB constraint — Prisma's schema DSL has
  no partial-unique-index primitive to express "unique among rows where
  status = OPEN"; this is the same class of "invariant the DSL can't reach,
  enforced in application code instead" tradeoff `License`'s
  at-most-one-`ACTIVE`-per-tenant rule already takes in this codebase.
- **Geo-fencing is per-branch, opt-in, and only meaningful for self-service
  sources.** `Branch.geofenceLat`/`geofenceLong`/`geofenceRadiusMeters`
  (three new nullable columns — a small additive seam on an existing
  Phase-0 model, the same pattern 0.7 used for `Branch.headUserId`) — all
  three null (the default) means geo-fencing is OFF for that branch, every
  clock-in/out is accepted regardless of location. Once configured, a
  `WEB`/`MOBILE` clock WITHOUT coordinates is rejected (`400`) — an
  optional feature per branch, but not optional to satisfy once a branch
  opts in, or it would have no teeth. `BIOMETRIC`/`MANUAL` sources skip the
  check entirely: a physical device sitting at a fixed location already
  enforces presence by construction, and a `MANUAL` regularization is HR
  correcting history, not a live presence check. `POST
/attendance/branches/:branchId/geofence` (gated by the pre-existing-but-
  previously-unused `branch.manage` permission, seeded in 0.4 in
  anticipation of exactly this kind of route and now newly seeded onto
  `HR_MANAGER` too) is this step's write surface — there was no branch
  CRUD endpoint of any kind before this step.
- **Optional selfie capture reuses 1.1's `StorageService`/MinIO as-is** —
  `clockInPhotoKey`/`clockOutPhotoKey` are object-storage keys
  (`attendance/<tenantId>/<employeeId>/<recordId>-<in|out>-<fileName>`,
  the same tenant/employee-partitioned bucket-layout convention
  `EmployeeDocumentsService` established), never the bytes themselves.
  Clock-in/out routes are MULTIPART (`FileInterceptor`, an optional
  `photo` field alongside `lat`/`long`/`source` text fields) — the SAME
  "binary content doesn't fit a JSON string" posture 1.1's document
  upload already established for this one route shape, while every other
  route in this module stays plain JSON.

## Shifts, rosters, and overtime

- **`ShiftDefinition`** is a tenant-defined template (`startTime`/
  `endTime` as "HH:mm" branch-local wall-clock strings, `crossesMidnight`
  denormalized at write time from `startTime >= endTime`). **
  `RosterAssignment`** assigns one employee to one shift for a date range
  (`effectiveTo: null` = ongoing) — resolution
  (`ShiftResolutionService.resolveForDate`) picks the assignment with the
  LATEST `effectiveFrom` whose range covers the queried date, the same
  "most specific/most recent wins" shape used elsewhere in this schema
  (analogous to `CountryPack`'s highest-version-active pick, 0.5) rather
  than requiring assignments to be non-overlapping at write time.
- **Overtime is entirely pack-driven — THE RULE (country-packs.md) holds.**
  `computeRecordMetrics` (`attendance-metrics.util.ts`) is the ONE function
  shared by clock-out and regularization-approval: `workedMinutes` =
  elapsed time minus the shift's `breakMinutes`; `overtimeMinutes` = the
  excess over the effective Country Pack's
  `workingTime.overtimeRules.dailyThresholdHours` (US and Qatar's
  reference packs both set this to 8, with different multipliers — the
  multiplier is reported for a future payroll module's cost calculation,
  not consumed here); `lateMinutes` = elapsed time between the shift's
  SCHEDULED start (as a real instant, see below) and the actual
  `clockInAt`. Nothing here ever branches on a country code — the same
  function computes both packs' results from their own data.
  **`weeklyThresholdHours` aggregation is a documented, out-of-scope
  simplification for this step** — only the DAILY threshold is applied;
  summing worked minutes across a pack-defined work week would need a
  week-boundary convention (from `locale.firstDayOfWeek`) this step didn't
  need to invent, the same "documented gap, not silently accepted" posture
  1.2's leaver-pro-ration gap already takes.

## Timezone correctness — the hard part

- **All timestamps are stored/transmitted in UTC** (this codebase's
  existing convention, see [i18n-timezone-rtl.md](./i18n-timezone-rtl.md)).
  `attendance-timezone.util.ts` is the ONE place this module does real
  timezone MATH — as opposed to `@hrm/shared`'s `formatInTimeZone`, which
  renders a UTC instant as a human-readable STRING for display and is
  deliberately not machine-parseable back into numbers. `toBranchLocal`
  extracts the branch-local calendar date + minutes-of-day from a UTC
  instant via `Intl.DateTimeFormat.formatToParts` (never string-parsing a
  rendered date); `branchLocalToUtc` is the reverse (a branch-local
  wall-clock time -> the real UTC instant), via the standard iterative-
  offset-correction technique (guess, see what it renders as locally,
  adjust by the difference — two iterations converges for every real IANA
  zone). A DST transition falling exactly on the day being computed could
  theoretically leave `branchLocalToUtc` off by up to an hour — a
  documented, accepted simplification, since it only affects the reported
  `lateMinutes` figure, never `workDate` attribution (which only ever uses
  the forward direction).
- **`workDate` — the branch-local working day — is resolved ONCE at
  clock-in and FROZEN, never recomputed at clock-out.** This is what makes
  "a clock-in late at night and a clock-out after midnight is ONE shift,
  attributed to the correct working day" true: clock-out just closes
  whatever record is already `OPEN`, regardless of what local calendar
  date the clock-out itself happens on.
  `ShiftResolutionService.resolveForClockIn` is the actual algorithm:
  1. Resolve the branch-local calendar date/time of `clockInAt`
     (`toBranchLocal`, using the EMPLOYEE'S OWN BRANCH timezone — never
     the server process's).
  2. Look up YESTERDAY's roster assignment FIRST. If it resolves to a
     shift that `crossesMidnight` AND the clock-in's local time-of-day
     falls before that shift's `endTime`, this clock-in is the tail end of
     a shift that started yesterday — `workDate` is YESTERDAY, and that
     shift is what gets snapshotted onto the record
     (`resolveWorkDate` — a small pure function used by both this decision
     and the check above, kept as ONE source of truth).
  3. Otherwise, fall back to TODAY's own roster resolution, and `workDate`
     is today's local calendar date.
  4. With no resolved shift at all (an un-rostered employee), `workDate`
     is simply the clock-in's own local calendar date — a documented
     simplification: an un-rostered employee clocking in just after
     midnight is attributed to the new day, not the day before, since
     there is no midnight-crossing signal to act on.
     The YESTERDAY-first lookup (step 2) is deliberate, not an
     optimization detail: it is what correctly handles a SINGLE-DAY roster
     assignment for a crossing-midnight shift, not just a multi-day
     continuous range — looking up "today" alone would miss a one-day
     assignment entirely for a post-midnight clock-in. Verified directly
     (real Postgres, no HTTP) by
     `shifts/shift-resolution.service.spec.ts` for TWO different branch
     timezones (`America/New_York`, `Asia/Qatar`), including that exact
     single-day-assignment case.
- **Two branches in different timezones compute independently and
  correctly** because every step above reads the EMPLOYEE'S OWN branch's
  `timezone` column (set since 0.2) — there is no global "the server's
  timezone" concept anywhere in this module's logic.

## Regularization — THE RULE applied, again

- A missed/incorrect punch correction is JUST a `WorkflowInstance` with
  `entityType: "AttendanceRegularization"` — this module owns no
  approve/reject state machine of its own, the identical shape 1.2's
  `LeaveService` already established for leave requests.
  `AttendanceRegularizationService.submit` creates the
  `AttendanceRegularization` row (`PENDING`), then calls
  `WorkflowEngineService.startInstance` and lets the generic engine take
  over completely; `AttendanceRegularizationController` DELIBERATELY has
  no approve/reject/cancel route — a caller acts on it via the SAME
  generic `POST /workflow/instances/:id/steps/:stepId/actions` /
  `POST /workflow/instances/:id/cancel` routes any other workflow-driven
  module uses, via the `workflowInstanceId` returned on
  `GET /attendance/regularizations/:id`. The seeded approver rule is
  `MANAGER`, resolved through 1.1's real `Employee.managerId` org chart —
  zero new code in `apps/api/src/workflow/approver-resolver.service.ts`.
- **`attendanceRecordId` is a plain UUID reference, no FK relation** —
  null means "a fully missing punch" (no existing record for `workDate` at
  all; `requestedClockInAt` is then required at submission, enforced by
  the service). This is NOT an arbitrary style choice: `AttendanceRecord`'s
  own primary key is the partition-compatible composite `(id, workDate)`
  (see below), so a composite FK into it would need `workDate` carried on
  the referencing table too and would conflict with the "every unique
  constraint on a partitioned table must include the partition key" rule
  if `AttendanceRecord` ever actually gets partitioned — the same
  reasoning `WorkflowInstance.entityId`/`LeaveRequest.workflowInstanceId`
  already establish for "just an id, not a structural relation" elsewhere
  in this schema, extended here for a genuinely new reason (partition
  compatibility, not polymorphism).
- **`AttendanceRegularizationWorkflowEventsListener`** is the ONLY place
  this module ever mutates a real `AttendanceRecord`, reacting to the
  engine's own `workflow.approved`/`.rejected`/`.canceled` events (filtered
  to `entityType === "AttendanceRegularization"`, the SAME fire-and-forget
  own-`withTenantContext`-transaction shape `LeaveWorkflowEventsListener`
  (1.2) already documents for itself, guarded by
  `status !== 'PENDING'` against a redelivered event ever double-applying):
  on `APPROVED`, it either patches an EXISTING record's
  `clockInAt`/`clockOutAt` (only the requested fields — the other side is
  left as-is) and recomputes `computeRecordMetrics`, or — when
  `attendanceRecordId` was null — CREATES a brand-new record on the
  regularization's own `workDate`, tagged `clockInSource`/`clockOutSource:
MANUAL`. Either way it enqueues a fire-and-forget summary recompute for
  that employee/day afterward. `REJECTED`/`CANCELED` touch nothing beyond
  the regularization row's own status.

## Notifications, audit — already fully wired, zero new code

- Exactly the payoff 1.2 already demonstrates: because a regularization is
  JUST another `WorkflowInstance`, `workflow.submitted`/`.approved`/
  `.rejected` are already mapped notification event types with existing,
  entity-agnostic templates and recipient resolution (0.8) — "notify on
  submit/approve/reject, localized" arrived for free. `DomainEventAuditListener`
  (0.9) likewise already subscribes to `workflow.*` and derives a generic
  audit entry for every state change this module's requests go through.
  Only the HTTP mutations THIS module owns outright
  (`POST /attendance/regularizations`, clock-in/out, shift/roster
  creation, the geo-fence config route, the biometric demo route) are
  `@AuditLog`'d directly.

## Scale — the partition-ready design

- **`AttendanceRecord`'s primary key is the composite `(id, workDate)`** —
  the SAME shape `AuditLog` already established in 0.9, for the identical
  reason: Postgres requires the partition key to be part of every unique
  constraint/primary key on a partitioned table. **The intended partition
  key is `work_date`** — Phase 5.2 is expected to add the actual
  `PARTITION BY RANGE (work_date)` migration (optionally sub-partitioned
  `BY LIST` on `tenant_id` for very large tenants, per the original note
  above the `Tenant` model in `schema.prisma`); this step's shape is
  chosen so that migration lands as additive, not breaking. Verified
  directly against `information_schema.table_constraints`/
  `key_column_usage` in `attendance.e2e-spec.ts`.
- **Every index on `attendance_records` leads with `tenant_id`**
  (`@@index([tenantId, employeeId, workDate])`,
  `@@index([tenantId, branchId, workDate])`,
  `@@index([tenantId, employeeId, status])`) — tuned for the two access
  patterns this module actually needs: "this employee's records in a date
  range" and "is this employee currently clocked in" (the OPEN-record
  check every clock-in performs). Verified directly against `pg_indexes`
  in `attendance.e2e-spec.ts` — no index on this table omits `tenant_id`,
  so an unbounded cross-tenant scan isn't even expressible as a query plan
  this table's own indexes would favor.
- **Writes are minimal per clock-in/out** — one `AttendanceRecord`
  insert/update, one `Branch` read, one roster lookup (0-2 rows), no
  aggregate computation on the request path at all; overtime/lateness are
  computed from the single record already in hand, not by scanning
  history.
- **Heavy reads never hit `AttendanceRecord` directly.**
  `GET /attendance/reports/summary` — the team/period view — reads ONLY
  `AttendanceDailySummary`, a precomputed one-row-per-employee-per-day
  table populated by `AttendanceSummaryProcessor` (the 0.8 BullMQ pattern,
  reused as-is): fire-and-forget, one employee/one day, after every
  clock-out (cheap), and via a manual `POST /attendance/summary/run`
  trigger for a broader branch/tenant backfill — the SAME documented,
  accepted "not wired to a real scheduler yet" tradeoff 0.7's escalation
  sweep and 1.2's accrual job already take. A plain `upsert` per
  employee/day needs no separate idempotency layer (unlike 1.2's
  ADDITIVE accrual): this is a full RECOMPUTE from source data every
  time, so re-running it for the same period is naturally idempotent.
  `GET /attendance/records` (per-employee/day raw view) DOES read
  `AttendanceRecord` directly, but is always bounded to one employee (or
  an explicit branch/date-range filter) — never an unbounded aggregate,
  the same class of accepted read `LeaveService`'s team calendar already
  is.

## The biometric device seam

- `BiometricDeviceAdapter` (`devices/biometric-device.interface.ts`) is a
  seam ONLY — the SAME "swap one DI binding, no caller changes" pattern
  0.4's `AUTH_PROVIDER` (SSO) and 0.8's per-channel `NotificationProvider`s
  already establish. No real device protocol exists yet (no vendor SDK, no
  webhook contract); the interface only defines the TRANSLATION contract
  from "a raw punch event" (`employeeCode`, `direction`, `deviceId`,
  optional `timestamp`) to a real clock-in/out call.
  `ManualBiometricDeviceAdapter` (bound today) resolves `employeeCode` to
  a real `Employee` and delegates straight to `AttendanceClockService`'s
  lower-level `clockInForEmployee`/`clockOutForEmployee`, tagged source
  `BIOMETRIC` — no bespoke attendance logic of its own. Exercised via an
  authenticated demo route, `POST /attendance/devices/manual-punch`
  (`attendance.write`). A real integration implements this same interface
  and changes only the DI binding in `attendance.module.ts`; it will
  likely need its OWN device-authentication story (an API key, not a user
  JWT) and may need to open its own `withTenantContext` transaction rather
  than running inside a request's — a documented decision for that future
  step, not this one.

## RBAC and branch scoping

- Four new permissions: `attendance.read`/`attendance.write`/
  `attendance.approve`/`attendance.regularize` — `TENANT_ADMIN` gets all
  four via `ALL_PERMISSIONS` as always; `HR_MANAGER`/`MANAGER` get all
  four (both approve/view team data); `EMPLOYEE` gets
  read/write/regularize (self-service: clock in/out, submit corrections,
  view own data — never someone else's, and never approve). This mirrors
  `leave.approve`'s exact role shape (1.2): `attendance.approve` is the
  "may act on/see ANOTHER employee's attendance data" gate — a caller
  without it is silently narrowed to their own linked `Employee` on every
  read/list/submit route (never a `403` for "someone else's data"), the
  same "RBAC gates the FEATURE, the service layer gates the ROW" two-layer
  shape 0.4 established. Branch scoping
  (`TenantContextService.getBranchIds()`) is enforced the same way
  `LeaveService`/`EmployeeService` already do — a restricted caller's
  queries are narrowed to their allowed branches, never a `403` for
  reads.

## API surface

- **Clock/records** (`attendance.controller.ts`): `POST /attendance/clock-in`,
  `POST /attendance/clock-out` (both multipart), `GET /attendance/records`
  (paginated/filtered), `GET /attendance/records/:id`,
  `POST /attendance/devices/manual-punch` (the biometric seam demo route),
  `POST /attendance/branches/:branchId/geofence`,
  `POST /attendance/summary/run`, `GET /attendance/reports/summary`.
- **Shifts/rosters** (`shifts.controller.ts`): `POST`/`GET /attendance/shifts`,
  `POST`/`GET /attendance/rosters`.
- **Regularization** (`regularization/attendance-regularization.controller.ts`):
  `POST /attendance/regularizations`, `GET /attendance/regularizations`,
  `GET /attendance/regularizations/:id`. Approve/reject/cancel are NOT
  here — see THE RULE above.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: `weeklyThresholdHours` overtime aggregation (only the daily
threshold is applied — see above); a `branchLocalToUtc` conversion landing
exactly on a DST transition day could be off by up to an hour in the
reported `lateMinutes` (never affects `workDate` attribution); an
un-rostered employee's midnight-crossing behavior is a documented
simplification (no shift, no crossing signal); the summary job's manual
trigger is not wired to a real scheduler yet, the same accepted tradeoff
0.7's escalation sweep and 1.2's accrual job already take; "site" is
treated as synonymous with `Branch` (no separate Site model) since this
system already models physical locations as branches.

Verified end-to-end over real HTTP by `apps/api/test/attendance.e2e-spec.ts`
(18 tests: clock-in/out recording correctly incl. rejecting a double
clock-in and a clock-out with nothing open; an optional selfie captured
and stored via real MinIO; geo-fencing rejecting a missing-coordinates and
an out-of-radius clock-in while an unconfigured branch accepts one with no
coordinates at all; the SAME summary job resolving `ABSENT` for a US
employee and `WEEKEND` for a QA employee on the identical Friday; a
regularization running through the real 0.7 workflow to the real 1.1
manager, correctly computing overtime and `workDate` on approval and
leaving no record behind on rejection; the biometric device seam tagging a
translated punch `BIOMETRIC`; RBAC deny-by-default; branch-scoped
visibility; cross-tenant isolation via RLS; and the partition-ready
composite-PK + tenantId-leading-index shape verified directly against
Postgres) plus five unit/integration spec files (33 tests — see
`docs/BUILD_LOG.md`'s 1.3 entry for the full list), including a real-
Postgres, no-HTTP proof of the crossing-midnight day-attribution algorithm
across two different branch timezones.
