# Attendance day-status classification (step 8.1, Part 2)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Pure backend logic: `apps/api/src/attendance/status/`. Classifies each attendance
day GREEN / YELLOW / RED / NEUTRAL / IN_PROGRESS against the Part-1
[working-hours policy](./working-hours.md). **No UI** (Part 3 = live clock +
monthly graph, Part 4 = leave allocation). Builds on
[attendance.md](./attendance.md) (records, branch-timezone handling, weekend/holiday
derivation) and `WorkingHoursResolverService`; changes none of them.

## Computed on read — never stored

The colour is **derived** from the stored `AttendanceRecord`s + the resolved policy

- pack/leave facts every time it is asked for. Nothing was added to the DB. Why:
  (1) a policy, holiday-calendar or approved-leave change is reflected instantly and
  history can never disagree with the current rules; (2) no backfill/recompute job to
  keep correct; (3) a range costs a fixed handful of queries (employee, branch, pack,
  **one** policy resolution — the resolver isn't date-versioned — records, leave),
  never per-day, so a month is one cheap read. If volume ever needs it, a rollup can be
  added behind the same service without changing callers.

## Endpoint

`GET /attendance/status?employeeId&from&to` — `employeeId` omitted = yourself;
`from`/`to` are branch-local `YYYY-MM-DD`, `from <= to`, at most **93 days**.
Requires `attendance.read`. Response:

```
{ employeeId, from, to, timezone,            // the member's BRANCH timezone
  policy: { startTime, workHours, breakHours, requiredHours, graceMinutes,
            halfDayThresholdHours, source },  // MEMBER | TEAM | COMPANY | COUNTRY_PACK
  days: [ ClassifiedDay ... ],                // one per calendar day, in order
  summary: { GREEN, YELLOW, RED, NEUTRAL, IN_PROGRESS } }   // counts
```

`ClassifiedDay`: `date`, `status`, `reason` (primary), `reasons[]` (every rule that
fired), `isLate`, `minutesLate`, `isEarlyOut`, `minutesEarly`, `isShortDay`,
`isHalfDay`, `hoursWorked`, `requiredHours`, `clockIn`, `clockOut` (UTC ISO or
null), `policySource`.

**Who may read whose** (all tenant-scoped/RLS): your own always; HR / admin / CEO
(`working_hours.manage`) anyone within their branch scope (out-of-scope = 404);
a **manager** (`attendance.approve`) anyone **below them in the management chain**
(the 7.2 `User.managerId` hierarchy, any depth, with the Employee-manager fallback) —
_not_ merely anyone in their branch; everyone else 403. Another tenant's employee
doesn't exist (404). Read-only, so not audited (consistent with every other read).

## Rules (in order)

All times are the member's **branch-local** wall clock; the expected start is turned
into a real instant (`branchLocalToUtc`), so lateness is true elapsed time — also
across a midnight-crossing shift. A record is attributed to its frozen `workDate`
(the day the shift **started**), so a 22:00→06:00 shift is classified on the start day.

1. **IN_PROGRESS** — an open record (no clock-out) started < 18 h ago (also covers a
   shift that began before midnight). `hoursWorked` is the running total. Takes
   precedence over everything (Part 3's live clock).
2. **NEUTRAL** (not good, not bad; any clock data is still returned): `NOT_EMPLOYED`
   (before join / after termination date), `WEEKEND` (the branch's Country Pack
   `weekendDays` — US Sat/Sun, Qatar Fri/Sat), `HOLIDAY` (pack public holidays),
   `ON_LEAVE` (an **APPROVED** leave covering the date; pending doesn't count),
   `FUTURE`.
3. A working day with **no record**: today ⇒ NEUTRAL `NOT_CLOCKED_IN` (the day isn't
   over); a past day ⇒ **RED `ABSENT`**.
4. Only an abandoned open record on a past day ⇒ **RED `MISSING_CLOCK_OUT`**.
5. Otherwise, with `minutesLate = floor((firstClockIn − expectedStart)/1min)` (≥0),
   `hoursWorked` = total elapsed clock-in→out (gross; matches `requiredHours = work +
break`; the stored net `workedMinutes` isn't used):
   - **RED** if _any_ of: late **beyond grace** (`minutesLate > graceMinutes`) →
     `LATE_BEYOND_GRACE`; `hoursWorked < halfDayThresholdHours` → `HALF_DAY`
     (`isHalfDay`); short **and** left before `expectedStart + requiredHours` →
     `EARLY_OUT` (`minutesEarly`); otherwise merely short → `SHORT_DAY`
     (`hoursWorked < requiredHours`). `reason` = the first that applies in that order;
     `reasons[]` has all.
   - **YELLOW** `WITHIN_GRACE` — late (> 0) but within grace, and hours complete.
   - **GREEN** `ON_TIME` — in at/before start and `hoursWorked >= requiredHours`.

Several records on one `workDate` (multiple shifts): earliest clock-in, latest
clock-out, summed hours.

**Status values**: `GREEN | YELLOW | RED | NEUTRAL | IN_PROGRESS`.
**Reason values**: `ON_TIME, WITHIN_GRACE, LATE_BEYOND_GRACE, HALF_DAY, EARLY_OUT,
SHORT_DAY, MISSING_CLOCK_OUT, ABSENT, WEEKEND, HOLIDAY, ON_LEAVE, NOT_EMPLOYED,
FUTURE, NOT_CLOCKED_IN, CLOCKED_IN` (exported as `DAY_STATUSES`/`DAY_REASONS`).

## Code

`attendance-day-classifier.ts` (pure `classifyDay`, no DB/clock — `now` is passed in),
`attendance-status.service.ts` (`AttendanceStatusService.classifyRange(tx, tenantId,
actor, {employeeId?, from, to}, now?)` — exported from `AttendanceModule`),
`attendance-status.controller.ts`. `attendanceStatusQuerySchema` in `@hrm/shared`.

## How Part 3 (clock + monthly graph) should consume it

- **Monthly graph**: one `GET /attendance/status?from=<first>&to=<last>` (≤ 93 days →
  up to 3 months per call); colour by `status`, tooltip from `reason`/`minutesLate`/
  `hoursWorked`/`requiredHours`; `NEUTRAL` is grey/hatched. Use `summary` for the legend counts.
- **Live clock**: poll/refresh `from=to=today`; `IN_PROGRESS` + running `hoursWorked`
  (and `policy.startTime`/`requiredHours` for a "9h goal" ring). After clock-in/out,
  re-fetch the day — nothing is cached/stored.
- **Server-side reuse**: inject `AttendanceStatusService` (or `classifyDay` directly)
  rather than re-implementing any rule; pass `now` for deterministic tests.

## Honest gaps / decisions

- Half-day _leave_ isn't modelled (a leave day is wholly NEUTRAL).
- DST: `branchLocalToUtc` is accurate except possibly on the exact transition day
  (the documented attendance.md simplification) — affects only `minutesLate` there.
- Policies aren't effective-dated: today's policy applies to history (computed-on-read
  trade-off; the resolver already accepts a `date` for when versioning is added).

## Demo

`seed:demo` gives **Ivy Intern** (`intern@acme-demo.local`, US HQ, New York time;
override 07:30 / 8 h / grace 30 / half-day 4 h) ~30 days of mixed attendance: green,
yellow (late within grace), red (late beyond grace ×2, early-out ×2, half-day), plus
weekends and one approved-leave day (a pack holiday appears if one falls in the window).
Sign in as `hr@`/`ceo@` (or Ivy herself) and call the endpoint.

## Verification

See the 8.1 Part 2 entry in [BUILD_LOG.md](../BUILD_LOG.md).
