# Attendance UI — live analog clock + monthly graph (step 8.1, Part 3)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Frontend only (`apps/portal`). Consumes Part 2's `GET /attendance/status`
([attendance-status.md](./attendance-status.md)) **as-is** — no classification, policy, auth, RLS or
backend engine change. Every colour, reason and number on screen comes from that response; the client
only does calendar layout and a ticking `now`.

## What / where

| Piece                                        | File                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed client (`getAttendanceStatus`)         | `src/lib/api/attendance.ts` (`DayStatus`, `DayReason`, `ClassifiedDay`, `AttendanceStatusResult`)                                                                      |
| Pure helpers (month grid, tz-today, classes) | `src/lib/attendance-status.ts`                                                                                                                                         |
| Analog clock (SVG) + `useNow`                | `src/components/attendance/AnalogClock.tsx`                                                                                                                            |
| Today card (live clock / done / idle)        | `src/components/attendance/ClockWidget.tsx` (same name/`clock-toggle-button` as before, rewritten)                                                                     |
| Monthly calendar graph                       | `src/components/attendance/MonthlyAttendanceGraph.tsx`                                                                                                                 |
| Graph + "pick a member" (manager/HR)         | `src/components/attendance/MemberMonthView.tsx`                                                                                                                        |
| Screens                                      | `/dashboard` (clock card + compact own-month graph), `/attendance` (clock + full graph + picker)                                                                       |
| Strings                                      | `attendance.live.*`, `attendance.dayStatus.*`, `attendance.reason.*`, `attendance.tooltip.*`, `attendance.month.*` in `packages/shared/src/i18n/messages.ts` (en + ar) |
| Demo helper                                  | `apps/api/scripts/demo-clock-in.ts` → `pnpm --filter @hrm/api run demo:clock-in`                                                                                       |
| Tests                                        | `apps/portal/tests/attendance-ui.spec.ts` (+ fixtures in `global-setup.ts`)                                                                                            |

## The live clock

- **State is the server's.** `ClockWidget` calls `getAttendanceStatus` over `[UTC-today − 7, UTC-today + 1]`
  (one ≤ 9-day call: UTC-today ±1 always spans the branch-local "today" since offsets are ≤ ±14 h, and the
  extra days give a "last day's status" line). `IN_PROGRESS` ⇒ live clock; otherwise today's resulting status
  or the idle state. The branch timezone comes back in the response; "today" is derived from it
  (`ymdInTimeZone`), never from the browser's zone.
- **Re-sync, never cache.** Re-fetch on mount, after every clock-in/out (`onClockEvent` also bumps the
  monthly graph's `refreshKey`), every 60 s, and on tab visibility. Nothing is persisted client-side.
- **Elapsed is anchored, not counted.** `elapsed = now − serverClockIn` every render (a 1 s tick), so a
  background tab, a throttled timer or a reload can never drift it. If the browser clock disagrees with the
  server by > 2 min (measured at fetch: `fetchedAt − clockIn − hoursWorked`), that skew is subtracted.
  Goal = `policy.requiredHours`; ring/bar = `elapsed / required` (clamped at 100 %, overtime shown as text).
- **Analog face.** Pure SVG, token colours (`--c-accent-*`, `--c-ink-*`, `--c-surface`) so it re-themes with
  light/dark for free; shows **branch-local** time. Wrapped in `dir="ltr"` and deliberately **not mirrored**
  under RTL (clocks run clockwise everywhere); only its _placement_ flows with the layout.
- **Reduced motion.** The second hand sweeps per `requestAnimationFrame`; with
  `prefers-reduced-motion: reduce` it ticks once a second and the glow/pulse/fade are off (`motion-safe:`
  utilities + a `matchMedia` check). The time itself is information, so it still moves.
- **After clock-out:** a graceful fade to the day's status badge, hours vs required, the human reason, and —
  for a RED finished day — a **Half day** / **Short day** badge (from `isHalfDay` / `isShortDay`/`isEarlyOut`).
- **Test hooks:** `clock-live` / `clock-idle[data-state=idle|done]`, `analog-clock[data-live]`,
  `second-hand[data-second-deg]`, `clock-elapsed`, `clock-remaining`, `clock-progress-ring[data-progress]`,
  `clock-day-status[data-status]`, `clock-shortfall[data-kind]`.

## The monthly graph

- **One call per visible month** (`from` = 1st, `to` = last). Month nav is client state; the previous month
  stays dimmed on screen while the next loads. The first request uses the browser's month; once the response
  reveals the branch timezone the graph snaps to _that_ zone's current month if they differ.
- **Colour = `status`** (`STATUS_CELL_CLASS`): GREEN `bg-primary`, YELLOW `bg-amber-400` + dark text, RED
  `bg-danger`, **NEUTRAL a muted dashed cell** (clearly "off / not counted" — never green or red),
  IN_PROGRESS a surface cell with an accent ring + live dot. Solid fills use `primary`/`danger` (the tokens
  that stay dark under white text in both themes — design-system.md § 2), so light/dark is a pure variable
  swap. Each cell also carries a glyph (✓ ! ✕ –) and a full `aria-label`, so colour is never the only signal.
- **Legend = `summary`** (server counts), not recounted from the cells.
- **Tooltip** (hover _and_ keyboard focus; `group-focus-within`): date + status, **every** reason in
  `reasons[]` as friendly text, check-in/out (`formatTime`), hours worked vs required, minutes late/early.
  First/last-column tooltips hang from the cell's logical start/end so they never leave the card.
- **Reason → string** is a pure key convention: `attendance.reason.<REASON>` for all 15 codes
  (`ON_TIME, WITHIN_GRACE, LATE_BEYOND_GRACE, HALF_DAY, EARLY_OUT, SHORT_DAY, MISSING_CLOCK_OUT, ABSENT,
WEEKEND, HOLIDAY, ON_LEAVE, NOT_EMPLOYED, FUTURE, NOT_CLOCKED_IN, CLOCKED_IN`) and
  `attendance.dayStatus.<STATUS>` for the 5 statuses — a new server reason needs one en + one ar message.

### RTL (the highest-risk part)

The grid is a real ARIA grid of `role=row` blocks, each a plain `grid-cols-7`. Cells are laid out in
**logical** order (index 0 = first day of the week) with no `left`/`right`/`ml`/`mr` anywhere, so
`dir="rtl"` (set on `<html>` from the Country Pack's `locale.rtl`, see
[frontend-ess-mss.md](./frontend-ess-mss.md)) puts the first column on the **right** and mirrors the day
order with zero direction-specific code. Nav chevrons get `rtl:rotate-180`; the tooltip centres with
`rtl:translate-x-1/2`; month/weekday names come from `Intl` in the user's locale (`ar`). Weekend cells are
**never positioned by the UI**: US Sat/Sun vs Qatar Fri/Sat is just whatever the API marks NEUTRAL/`WEEKEND`.
Week start is Sunday for every locale (the status endpoint doesn't expose the pack's first-day-of-week — a
documented simplification).

## Manager / HR view

`MemberMonthView` offers a searchable "Team member" `Select` (default **Me**) to holders of
`attendance.approve` or `working_hours.manage`, populated from `GET /employees`. **No permission logic is
re-implemented**: choosing someone just passes `employeeId` to the same endpoint, and Part 2 decides (own
always; HR/admin/CEO within branch scope; a manager only their reporting chain). A refusal (403/404) renders
the friendly `attendance.month.forbidden` message instead of a raw error. Known gap: the picker lists
everyone the caller can _list_, not only people they can _view_ — picking an out-of-chain person is refused
at the API (proven in the spec); a "reports only" list would need a dedicated endpoint.

## Demo data

- **Colourful month:** sign in as `intern@acme-demo.local` (Ivy Intern, password `DemoPass-123!`, after
  `pnpm --filter @hrm/api run seed:demo`) → `/dashboard` (compact) or `/attendance` (full; ‹ › to the
  previous month where most of her 30 seeded days live).
- **Running clock:** `pnpm --filter @hrm/api run demo:clock-in` (default `intern@acme-demo.local`, 3 h ago;
  `demo:clock-in lead@acme-demo.local 5.5` for another member/offset; `… --out` clears today). It writes an
  OPEN `attendance_records` row (the only way to _backdate_ a session); clocking in with the real button on
  `/dashboard` works too and starts from 00:00:00.
- **Manager view:** `lead@acme-demo.local` (Ivy's manager) or `hr@`/`ceo@` → `/attendance` → Team member.

## Verification

See the 8.1 Part 3 entry in [BUILD_LOG.md](../BUILD_LOG.md).
