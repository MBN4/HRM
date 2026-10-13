# Shift scheduling & rostering (step 8.2)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in `packages/db` (one migration, `20261011090000_add_shift_scheduling`), `packages/shared`
(`scheduling.validator.ts`), `apps/api/src/scheduling` (new module) with small, additive changes to
`apps/api/src/attendance/{shifts,status}` and `apps/api/src/working-hours`, and `apps/portal`
(`/scheduling`, `/schedule`) + a read-only `apps/mobile` screen. **An extension of the existing
attendance `ShiftDefinition`/`RosterAssignment` and the 8.1 working-hours policy — not a parallel
system.** Attendance, auth, RLS, the leave/payroll engines, the hierarchy and the workflow engine are
consumed, never rebuilt. Builds on [attendance.md](./attendance.md),
[working-hours.md](./working-hours.md), [attendance-status.md](./attendance-status.md),
[team-hierarchy-approvals.md](./team-hierarchy-approvals.md), [workflow.md](./workflow.md).

## 1. The reconciled model (read this first)

Before 8.2 there were two overlapping ways to say "this team works 9–5": a `WorkingHoursPolicy`
(company / team / member: start, work+break hours, grace, half-day — drives classification) and a
`ShiftDefinition` + `RosterAssignment` (a named start/end/break, assigned per employee over a date
range — drives clock-in `workDate` attribution and lateness metrics). They are now **one mechanism**:

| Concept                             | What it is now                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shift** (`ShiftDefinition`)       | A named, reusable time block that **carries the working-hours parameters**: start, end, `breakMinutes`, `graceMinutes`, optional `halfDayThresholdHours`, plus a colour and an optional `minStaffing` coverage target.                                                  |
| **Working-hours values of a shift** | Derived, never redefined — `shiftToWorkingHours()` in `@hrm/shared` is the ONE mapping: `requiredHours` = the full start→end length (crossing midnight handled), `breakHours` = break/60, `workHours` = required − break, grace/half-day carried across.                |
| **Standing assignment**             | A `WorkingHoursPolicy` row (scope COMPANY / TEAM / MEMBER) whose new `shiftDefinitionId` is set. Its hours are read **live from the shift** (editing a shift changes everyone on it — they can never disagree). A DB `CHECK` forces "a shift **or** a full custom set". |
| **Dated roster assignment**         | A `RosterAssignment` "cell": one employee, one date (`effectiveFrom == effectiveTo`), a shift **or** a rostered `dayOff`. `status` DRAFT → PUBLISHED. Legacy 1.3 multi-day range rows still work and are PUBLISHED.                                                     |

**There is exactly one precedence chain**, and the resolver (`WorkingHoursResolverService`) is its only
implementation — attendance classification, clock-in, the working-hours "Effective" card, "My schedule"
and swaps all call it:

```
published dated roster (that exact day)
  >  member standing  >  team standing (nearest department)  >  company default   (all WorkingHoursPolicy rows)
  >  Country Pack
```

The resolved `source` is `ROSTER | MEMBER | TEAM | COMPANY | COUNTRY_PACK`; a `shift` (id, name, times,
`crossesMidnight`) is returned whenever the winning layer is a shift. `date` on `resolve()` — accepted
but ignored since 8.1 — now does what its doc comment promised: it consults the roster.
`resolveRange()` does one standing resolution + **one** roster query for a whole window (never per
day), so a 90-day classification stays a fixed handful of queries.

- **Draft cells are invisible** to the resolver, clock-in and classification — only PUBLISHED rows are live.
- Among overlapping dated rows the **narrowest span wins**, then the latest `effectiveFrom`
  (`pickRosterAssignment`): a one-day cell beats an ongoing legacy range for that date.
- A rostered **day off** resolves to _no shift_ — it must not fall through to the standing shift.
- **Weekends/holidays** still come from the branch's Country Pack: a _standing_ shift only applies on
  working days, but a **rostered shift on a weekend/holiday is a working day** (the explicit roster
  outranks the pack; approved leave still wins).
- The old `WorkingHoursPolicy` custom-hours rows remain fully supported. Setting custom hours on a row
  (the working-hours screen's `PUT`) clears its shift link; setting a standing shift clears its custom
  hours. One row, one meaning at a time.

### Why the standing assignment is a policy row (not a new table)

A second assignment table would need its own member > team > company walk and an interleaving rule
against custom policy rows ("does a member's custom hours beat a team's shift?"). Reusing the policy row
makes that question disappear: it is the same walk, over the same rows.

## 2. Part A — named shifts + standing assignment

`/scheduling/shifts` (CRUD; list includes derived `hours` and `usage` counts), `/scheduling/standing`
(list) and `PUT|DELETE /scheduling/standing/{company | teams/:departmentId | members/:employeeId}`.

- Shifts validate (zod + re-validation of the merged result on update): `HH:mm`, start ≠ end, break <
  length, half-day < length, unique name. **Overnight** = end ≤ start (`16:00–01:00`, `22:00–06:00`);
  `crossesMidnight` is denormalised at write time as before.
- A shift still referenced (standing assignment, roster row or swap) cannot be deleted (409) — the FKs
  are `RESTRICT`.
- A standing `DELETE` on a custom-hours row is refused (409 — manage it on the Working hours screen).

### Clock-in consumes standing shifts too

`ShiftResolutionService.resolveForDate` is now _published roster, else standing shift_ (it takes the
resolver as an `@Optional()` dependency; the standalone unit spec still constructs it bare). So a Sales
member on a standing 16:00–01:00 shift who clocks in at 00:30 is attributed to the **previous** day's
shift — exactly the existing midnight-crossing algorithm ([attendance.md](./attendance.md)), now fed by
the standing shift instead of requiring a hand-made roster row. The standing shift is looked up once per
clock-in (not once per day checked).

## 3. Part B — the rostering calendar

All under `/scheduling` (permission `scheduling.manage` unless noted; the service layer then scopes _who_).

| Route                                          | Purpose                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /roster?from&to&departmentId&branchId`    | The grid: employees (+ their standing layer), shifts, **cells** (with `status`, `fromRange`), approved-leave days, per-branch weekend/holiday facts. ≤ 42 days. |
| `PUT /roster/cells`                            | Set / clear up to 500 cells. `shiftDefinitionId` = shift, `dayOff: true` = day off, neither = **clear**. All-or-nothing scope check. New cells are DRAFT.       |
| `POST /roster/copy`                            | "Copy last week": cells in `[sourceFrom, sourceTo]` re-written at the same weekday offset from `targetFrom` (rotations), through the same write path.           |
| `POST /roster/publish`                         | Publish every DRAFT cell in `[from, to]` for the people the caller may schedule; one `roster.published` notification per affected employee.                     |
| `GET /coverage?from&to`                        | Per day, per shift: who is on it, headcount vs `minStaffing`, **gaps**, plus default-hours / off / on-leave counts.                                             |
| `GET /people`                                  | The teams and people the caller may schedule (pickers).                                                                                                         |
| `GET /my-schedule?from&to` (`attendance.read`) | The caller's own days (default today + 13): shift / day off / weekend / holiday / leave / default hours, `via` ROSTER or STANDING, open swaps.                  |
| `GET /colleagues` (`attendance.read`)          | Active colleagues with a login in your branch (the swap picker).                                                                                                |

**One write path.** `RosterWriteService.applyCells` is the only place cells are written — the manager
calendar and the approved-swap listener both use it. A "cell" is a single-day `RosterAssignment`; a
**partial unique index** (`tenant_id, employee_id, effective_from WHERE effective_to = effective_from`)
guarantees one per employee per date.

### Publish semantics

New cells are DRAFT (hatched in the grid; invisible to the employee, clock-in and classification) until
published. **Editing or clearing an already-PUBLISHED cell takes effect immediately and notifies the
employee** (`roster.changed`: previous → new shift) — the "changes after publish are visible/notified"
rule. A _new_ cell added after publishing is DRAFT until the next publish. Honest limit: there is no
"draft edit of a published week" (a pending-changes layer) — an edit to a published cell is live.

### Past days

Classification is computed on read, so changing a past roster day would silently recolour already-judged
attendance. Managers therefore **cannot edit days before today in the employee's branch timezone** (400);
tenant-wide actors (HR/admin/CEO) can correct history.

### Coverage and performance

`RosterGridService` spends a fixed query budget regardless of team size or window: one employee list, **one**
batch standing resolution (`resolveStandingBatch` — all policy rows + all departments, walked in memory),
one roster query, one leave query, one pack read per distinct _branch_, then in-memory expansion.
A grid is capped at 1,000 people. A **gap** = a shift with a `minStaffing` target and fewer people than that
on a day somebody actually works (a pure-weekend day never reports a gap). Coverage counts the _plan_
(DRAFT cells included) so a manager can see gaps before publishing; each person carries their cell `status`.

## 4. Who may do what (RBAC + scope + hierarchy)

New permission **`scheduling.manage`** — `TENANT_ADMIN`/`CEO` (all permissions), `HR_MANAGER`, **`MANAGER`**;
not `EMPLOYEE`. Backfilled for existing tenants by the migration. It is _scoped_, not global:

| Action                                                 | Who                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Roster / publish / copy / member standing shift        | `scheduling.manage` **and** the target is in the actor's branch scope **and** (a manager) **below them in the management chain**              |
| Define / edit / delete shifts; team & company standing | `scheduling.manage` **plus tenant-wide authority** = `working_hours.manage` (HR / admin / CEO). Company standing also needs all-branch scope. |
| Read shifts, "My schedule", request/answer a swap      | `attendance.read` / `attendance.write` (every employee)                                                                                       |

"Manager scope" is the same discriminator the attendance-status read uses: `working_hours.manage` =
tenant-wide, otherwise the 7.2 reporting chain (`User.managerId`, any depth, with the Employee-manager
fallback for people without a login) — `SchedulingScopeService`. Out-of-branch or other-tenant people are
a **404**, never a hint; an in-branch non-report is a **403**. Every mutation is audited (0.9).

**Security fix made on the way:** the pre-existing `POST /attendance/shifts`, `POST /attendance/rosters` and
`GET /attendance/rosters?employeeId` needed only `attendance.write`/`.read` — which every **employee**
holds. The two writes now need `scheduling.manage` + tenant-wide authority (legacy range assignment is
HR-only; managers use `/scheduling`), and reading someone else's roster needs `scheduling.manage`.

## 5. Classification consumes the day's effective shift

`AttendanceStatusService.classifyRange` calls `resolveRange` once and judges **each day against that day's
own schedule**: `classifyDay` receives the day's `requiredHours`, `startTime`, `graceMinutes`,
`halfDayThresholdHours`, `policySource` (now possibly `ROSTER`), `rostered`, `dayOff` and `shift`. The rules in
[attendance-status.md](./attendance-status.md) are unchanged; only their _inputs_ became per-day. New: reason
**`DAY_OFF`** (NEUTRAL; a rostered day off beats the pack weekend), and `ClassifiedDay` gains `shift`,
`expectedStartTime`, `graceMinutes`. `workDate` is still the day the shift _started_, so a 16:00→01:00 shift is
classified on its start day and "on time"/"late" are true elapsed time across midnight.

## 6. Shift swap (via the workflow engine)

```
AWAITING_PEER --colleague accepts--> PENDING_APPROVAL --manager chain approves--> APPROVED (rosters rewritten)
   | declines -> DECLINED                 | rejected -> REJECTED     | requester cancels -> CANCELED
```

`POST /swaps {date, counterpartEmployeeId, reason?}`, `POST /swaps/:id/respond {accept}`, `POST /swaps/:id/cancel`,
`GET /swaps?scope=mine|team`. **THE RULE holds** ([workflow.md](./workflow.md)): approval is a real
`WorkflowInstance` (`entityType: "ShiftSwap"`, a `MANAGER`-rule template, i.e. the requester's management
chain) — there is deliberately no approve route; the approver acts in the existing `/approvals` inbox.
`ShiftSwapWorkflowEventsListener` only reacts to the engine's terminal events. The colleague's consent is a plain
pre-step (the engine models approvers, not peers).

- Semantics: a **hand-off / trade of one day**. The requester must have an effective shift that day (a published
  cell, or a standing shift on a working day); same branch; colleague active with a login; not the past; one open
  request per day. On approval the colleague takes the requester's shift and the requester takes the colleague's
  (or a **day off** if the colleague had none).
- Each side's effective shift is **snapshotted at request time**; if either changed before approval, the swap is
  `CANCELED` with `decisionNote: ROSTER_CHANGED` instead of overwriting someone's newer roster.
- A tenant needs an active `ShiftSwap` workflow template (like Leave): the demo seed creates one; a tenant
  without one gets the engine's "No active workflow template" error when the colleague accepts.

## 7. Notifications

Three new mapped events (`@hrm/shared` `NOTIFICATION_EVENT_TYPES`, templates seeded en + ar in
`seed-notification-templates.ts`, recipient = the payload's `employeeUserId`): `roster.published`,
`roster.changed`, `shift_swap.requested`. Approve/reject outcomes reach the requester through the generic
`workflow.approved|rejected` notifications. Delivery channels follow each user's preferences.

## 8. UI

`/scheduling` (manager/HR roster calendar with week/month views, team filter, click/multi-select assignment,
copy last week, publish, draft counter; coverage tab; shifts tab; standing tab) and `/schedule` ("My schedule" +
swap requests; an upcoming-shifts card on `/dashboard`); a read-only "My schedule" on mobile. The calendar uses the
MBN design system, i18n (en + ar), logical (RTL-safe) CSS, light/dark. See the 8.2 entry in
[BUILD_LOG.md](../BUILD_LOG.md) for what was verified in a real browser.

## 9. Honest gaps / decisions

- No pending-changes layer on a published week (see Publish semantics).
- Standing shifts apply on the branch's _working days_ only; a night-shift team that should also staff weekends
  needs dated cells (that is what the calendar is for).
- Policies/shifts are not effective-dated: editing a shift re-judges history on read (the same trade-off
  attendance-status.md documents for policies).
- Coverage `minStaffing` is per shift per day across the people the caller can see; there is no per-team staffing
  target or skills model.
- Swap is 1-for-1 on one day, same branch; multi-day and multi-party swaps are a fast follow.
- A manager's calendar lists their reporting chain only; a manager who is also a member of someone else's chain
  is rostered by _that_ person.

## 10. Demo data

`seed:demo` (acme-demo): shifts **Morning** 09:00–17:00, **Sales Afternoon** 16:00–01:00 (overnight), **Night**
22:00–06:00; standing — US HQ _Operations_ → Morning, US HQ _Sales_ → Sales Afternoon, Doha _Operations_ → Morning
(Ivy Intern keeps her member hours: member beats team); a ShiftSwap workflow template; and a two-week roster for 13
people (US Sales under Leo Teamlead + Doha Operations incl. the Doha login's own employee) — week 1 **published**,
week 2 **draft**, with alternating Morning/Sales-Afternoon groups, a mid-week day off and a "Night this weekend" cover.
Sign in as `pm@`/`lead@acme-demo.local` (manager view of their reports), `hr@`/`ceo@` (everyone, can define shifts),
or `demo.qa@acme-demo.local` (Doha — Arabic RTL; also has "My schedule"). Password `DemoPass-123!`.

## 11. Verification

See the 8.2 entry in [BUILD_LOG.md](../BUILD_LOG.md).
