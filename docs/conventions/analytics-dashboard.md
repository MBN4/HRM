# Analytics dashboard

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 1.5 (Phase 1's final step) — `packages/db`, `packages/shared`,
`apps/api/src/analytics`, `apps/portal`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)
(the "1.5 analytics dashboard" entry) for the full file list and
verification notes. This step is deliberately a pure AGGREGATOR: it reads
Employee (1.1), Leave (1.2), and Attendance (1.3) data and rolls it up —
nothing about those modules' own business logic, RLS, or auth changed, and
the one new capture point (`Employee.terminatedAt`, below) is narrowly
scoped to a single field on a single status transition.

## The KPI set

- **Headcount** — total, by branch, by department, by employment type, by
  gender (the "optional diversity split").
- **Joiners / leavers / attrition** over a period.
- **Attendance rate**, and present/absent/late/on-leave/weekend/holiday
  counts, as a trend over the period.
- **Leave utilization by type** — entitled/used-to-date/used-in-period/
  utilization%.
- Every KPI respects the viewer's branch scope and a `branch`/`department`/
  date-range filter set.

## Scale — the rollup strategy, and why it's built this way

**The hard requirement**: at 20M users, a dashboard load must never run a
live aggregate/`GROUP BY` over `employees`, `attendance_records`,
`leave_requests`, or `leave_balances` — the same "heavy reads never hit the
primary" rule 1.3 established for `AttendanceDailySummary`
(see [attendance.md](./attendance.md)), extended here across the whole
dashboard.

- **Four new rollup tables**, all ordinary tenant-scoped RLS tables (every
  index leading with `tenant_id`, same as every table since 0.2 — see
  [tenancy-rls.md](./tenancy-rls.md)):
  - `HeadcountDailySnapshot` — a POINT-IN-TIME cross-section (tenant,
    snapshotDate, branchId, departmentId, employmentType, gender) →
    `activeCount`. Querying a date RANGE means reading the single LATEST
    `snapshotDate` within it, not summing across days — summing would
    double-count the same people.
  - `WorkforceMovementDailyCount` — (tenant, movementDate, branchId,
    departmentId, movementType: `JOINER`|`LEAVER`) → `count`. A date range
    SUMS this one, since each day's count is a genuinely distinct-day
    event count.
  - `AttendanceDailyBranchSummary` — a ROLLUP OF A ROLLUP: computed by
    grouping 1.3's own `AttendanceDailySummary` (already ≤1 row/employee/
    day) by `(branchId, departmentId, status)`. This job never touches raw
    `AttendanceRecord` at all — exactly "reuse/extend the attendance
    summary approach" as asked.
  - `LeaveUtilizationDailySnapshot` — computed by grouping the
    CURRENT-YEAR `LeaveBalance` rows (already ≤1 row/employee/type/year)
    joined to `Employee` for branch/department. `totalUsedDays` is
    cumulative for the year, same as the balance row it's summed from;
    reading "usage within `[from, to]`" means diffing the latest snapshot
    on/before `to` against the latest on/before `from` (delta of the
    cumulative total), not summing this table across days either.
  - All four are computed at a granular cross-section
    (branch × department × a small enum), not one giant row — bounded by
    the number of real branch/department/employmentType/gender/leaveType
    combinations a tenant actually has (tens to low hundreds), never by
    headcount. A dashboard read fetches and sums THOSE small rows, not the
    underlying millions of employee/attendance/leave rows.
- **A real gotcha, worth calling out explicitly**: `departmentId` is
  NULLABLE on all four tables (an employee may have no department) —
  Postgres treats every `NULL` as DISTINCT in a unique index, so an upsert
  keyed on a unique constraint that includes it would silently INSERT a
  fresh duplicate row on every job re-run for any "no department"
  combination, rather than updating the existing one. The fix, applied
  uniformly: the rollup job DELETEs every existing row for the
  `(tenantId, theDate)` grain first, then does ONE bulk `createMany` of
  the freshly computed rows — the same "a full RECOMPUTE from source data
  is naturally idempotent" argument `AttendanceDailySummary`'s own doc
  comment already makes for itself (see [attendance.md](./attendance.md)),
  just applied as delete+bulk-insert (one job run produces MANY rows at
  once here) instead of a per-row upsert. Each table's `@@unique`
  documents the intended grain / gives defense-in-depth within one
  computation pass; it is NOT what the job relies on for idempotency
  across re-runs.
- **The dashboard read side** (`AnalyticsDashboardService`) queries ONLY
  these four tables — never `Employee`/`AttendanceRecord`/`LeaveRequest`/
  `LeaveBalance`. Proven directly, not just trusted, by
  `apps/api/test/analytics.e2e-spec.ts`: every `Employee` row for the
  tenant is deleted AFTER the rollup runs (cascading away
  `AttendanceDailySummary`/`LeaveBalance`/etc. with it — none of the four
  rollup tables carry an FK to `Employee`), and the dashboard's JSON
  response is asserted byte-identical before and after.

## The first real scheduled job in this codebase

Every prior "periodic" job in this system (0.7's escalation sweep, 1.2's
leave accrual, 1.3's attendance summary) is a documented, accepted "manual
trigger only, scheduling infra is out of scope" gap — see
[workflow.md](./workflow.md), [leave.md](./leave.md),
[attendance.md](./attendance.md). This step's own explicit brief ("compute
aggregates via SCHEDULED BullMQ jobs") is what finally closes that gap, for
this one job: `AnalyticsRollupService.onModuleInit()` registers ONE
repeatable job via BullMQ's plain `repeat: { pattern }` option — a
capability the already-pinned `bullmq@^5.28.2` dependency already has, so
this needed no new infrastructure. Registering the same `{ pattern, jobId }`
pair on every app boot is idempotent (BullMQ dedupes by that pair), so this
never creates duplicate schedules.

The orchestrator job itself (`orchestrate`, no `tenantId`, runs OUTSIDE any
tenant context) lists every `TRIAL`/`ACTIVE` tenant via the OWNER `prisma`
client — the same "infrastructure listing, not a tenant query" posture
`ReadinessService` already takes for its own DB check (`Tenant` itself is
RLS-exempt, see [tenancy-rls.md](./tenancy-rls.md)) — and fans out one
`rollup-tenant` job per tenant. `POST /analytics/rollup/run` still exists
as a manual backfill/test lever, the same shape 1.2/1.3's own (unscheduled)
jobs already have — this module's own equivalent job just also has a real
schedule now. Deliberately NOT retrofitted onto 1.2/1.3's own jobs — out of
this step's scope; those gaps stay separately documented where they
already are.

## `Employee.terminatedAt` — the one new capture point

Leaver/attrition KPIs need a real termination DATE, which didn't exist
anywhere in this schema — leave.md already flagged "no termination date
column" as an accepted gap (blocking leaver pro-ration). `terminatedAt` is
a small, nullable, additive column (same pattern as `Branch.geofenceLat`/
`User.pushToken`), set by `EmployeeService.update` the moment `status`
transitions INTO `TERMINATED` from something else, and cleared back to
`null` on a reactivation OUT of `TERMINATED` — a few lines next to the
existing status-patch logic, not a leave/payroll pro-ration change (that
remains leave.md's own documented gap, unaffected by this step).

## RBAC and branch scoping

One permission, `PERMISSIONS.ANALYTICS_READ` (`analytics.read`) — seeded
onto `HR_MANAGER`/`MANAGER` (plus `TENANT_ADMIN` via `ALL_PERMISSIONS` as
always); `EMPLOYEE` does not hold it. Unlike `leave.approve`/
`attendance.approve`, this is a single-tier gate with no "view your own"
carve-out: there is no per-employee ROW to narrow an unprivileged caller
to here, only branch scope — enforced entirely inside
`AnalyticsDashboardService` (`allowedBranchIds` narrows every query for a
restricted caller; an explicit out-of-scope `branchId` filter returns an
empty/all-zero dashboard, never a `403` — the same "RBAC gates the
FEATURE, the service layer gates the ROW" two-layer shape 0.4 established,
see [auth-rbac.md](./auth-rbac.md)).

## UI (`apps/portal`)

A new `/analytics` screen, gated by `can(PERMISSIONS.ANALYTICS_READ)` in
both the sidebar nav (hidden entirely for a caller without it) and the
page itself (a graceful notice, not a crash, for a direct visit — the same
posture the `/team` screen already takes, see
[frontend-ess-mss.md](./frontend-ess-mss.md)). Branch + date-range filters;
KPI tiles; a headcount-by-branch bar chart and an attendance trend line
chart via a new dependency, `recharts` (no chart library existed in this
app before this step); employment-type/gender breakdown lists; a leave
utilization table. All numbers are rendered through the existing
`lib/format.ts` (`formatPercent` added there) — never a hardcoded locale or
currency. **Charts themselves are not mirrored for RTL** — a deliberate,
documented simplification consistent with common dashboard practice (axis/
bar direction isn't inherently meaningful the way running text is); every
label, tooltip, and number around the chart IS locale/RTL-correct.

## Known, documented gaps for this phase

Not required by this step's brief, flagged so they aren't silently
forgotten: the portal has no department-picker filter (no
departments-listing endpoint exists anywhere in this API yet — the backend
route still accepts `departmentId`, for a future caller); leave
utilization's "used in period" is a delta between the two nearest daily
snapshots, not a re-derivation from `LeaveRequest` history, so a range
older than this feature's own rollup history reports a zero baseline
(documented, same spirit as leave.md's carry-over placeholder); joiner/
leaver movement is grouped by the employee's CURRENT branch/department,
since this schema has no historical assignment log (same simplification
attendance.md's un-rostered-employee gap already takes elsewhere); 1.2/1.3's
own accrual/summary jobs remain manual-trigger-only, unchanged by this
step's real scheduler.

Verified end-to-end over real HTTP by
`apps/api/test/analytics.e2e-spec.ts` (5 tests: KPI numbers computed
correctly from seeded employees/leave/attendance across two branches; the
direct rollup-only-reads proof described above; branch-scoped visibility
incl. an out-of-scope filter returning zeros, not a 403; RBAC
deny-by-default; cross-tenant isolation via RLS) plus
`analytics-rollup.util.spec.ts` (9 pure aggregation-function tests) and
`apps/portal/tests/analytics.spec.ts` (3 real-browser Playwright tests:
tenant-wide KPIs summed correctly across branches, a branch-restricted
manager seeing fewer than the tenant-wide view, and a plain employee
getting a graceful notice rather than a crash).
