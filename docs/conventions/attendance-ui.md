# Live clock + monthly attendance graph (step 8.1, Part 3)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Frontend-only (`apps/portal`). Consumes
[Part 2's `GET /attendance/status`](./attendance-status.md) exactly as-is —
nothing here reclassifies a day; every color, reason, and count comes
straight from the server response. No backend/working-hours/auth/RLS change.
Builds on [working-hours.md](./working-hours.md) and
[design-system.md](./design-system.md) (the MBN token palette, `Select`,
`Tooltip`, `Badge`/`StatusBadge`, theme toggle).

## 1. The live analog clock — `ClockWidget.tsx`

The SAME component on `/dashboard` and `/attendance` (zero changes to either
page's import) now branches on whether `GET /attendance/status` (queried for
a `[yesterday, today, tomorrow]` browser-local window — see "Known gaps"
below) returns an `IN_PROGRESS` day:

- **Clocked in**: `LiveAnalogClock` (a purely decorative, ticking wall-clock
  face — hour/minute/second hands rotated via inline `transform`, brand/
  accent-colored, `role="img"` with the current time as its accessible name)
  next to `GoalRing` (an SVG circular progress arc toward the resolved
  policy's `requiredHours`). The **elapsed** number is computed client-side
  every second from `now - new Date(day.clockIn)` — `day.clockIn` is the
  server's own instant; nothing about the duration is fabricated, only "now"
  ticks locally. Shows remaining time, or "X over goal" once the goal is
  passed. A "Live" badge pill.
- **Not clocked in / already clocked out today**: the analog clock and ring
  are replaced by the day's resulting `StatusBadge` + reason text, plus an
  explicit "Short day"/"Half day" line when `isShortDay`/`isHalfDay` — the
  spec's own "the day will be RED, make it clear why" requirement. The
  clock-in button (and the existing photo/geo capture, untouched) is always
  available, since a day can have more than one shift.
- **Re-sync**: `reload()`s on every clock-in/out success, plus a plain
  60-second interval — the server is the single source of truth; nothing is
  cached (Part 2's own doc already establishes this).
- **`prefers-reduced-motion`**: `useReducedMotion()` (`lib/useReducedMotion.ts`,
  a `matchMedia` listener — new, since the hands rotate via inline `style`,
  which Tailwind's `motion-safe:` prefix can't reach) drops the hands'
  sweep transition; the ring's fill animation uses `motion-safe:` directly.

## 2. The monthly graph — `MonthlyAttendanceGraph.tsx`

One `GET /attendance/status?from=<first of month>&to=<last of month>` per
visible month (well under the 93-day cap even for the longest month), month
navigation (prev/next, localized month/year label), a 7-column calendar grid
(leading blank cells for the first week), colored by `status` (brand=GREEN,
amber=YELLOW, coral=RED, muted sand=NEUTRAL, sky/info=IN_PROGRESS with a
decorative pulse dot — a verified-contrast tone, see "Accessibility" below),
a legend read straight from `summary`, and a `Tooltip` per day (check-in/
check-out, hours worked vs. required, every fired reason).

- **Reason -> string**: `attendance.reason.<CODE>` i18n keys (en+ar) for
  all 15 `DAY_REASONS`; `attendance.dayStatus.<STATUS>` for the 5
  `DAY_STATUSES`. No other reason-text mapping exists anywhere else.
- **Manager/HR view**: gated on `attendance.approve` OR `working_hours.manage`
  (the same two permissions Part 2's own `resolveTarget` checks) — a
  searchable `Select` (reusing `listEmployees`, exactly
  `EffectivePolicyCard.tsx`'s own picker pattern from `working-hours.md`)
  lets a manager/HR pick a member and see their month through the SAME
  component. **The UI does not reimplement who-may-see-whom** — Part 2's own
  reporting-chain/branch-scope check is what actually decides; an
  out-of-scope pick simply surfaces the API's 403/404 as an `Alert`.

### RTL — the highest-risk part

The grid is a plain `grid-cols-7` with day cells in Sun→Sat **document**
order; under `dir="rtl"` (set on `<html>` from the signed-in member's OWN
resolved Country Pack — see `SessionProvider`/`I18nProvider`, unchanged),
CSS Grid mirrors the whole row automatically — the FIRST DOM cell renders at
the visual right, with no manual `order`/`flex-direction` overrides needed
anywhere in this component. The weekday header row is the same grid, so it
mirrors identically. **Weekends are never hardcoded**: a US-branch member's
Sat/Sun and a QA-branch member's Fri/Sat both arrive as plain `NEUTRAL`
`WEEKEND` days in the already-resolved `days[]` — the component only reads
`status`/`reason`, it has no weekend-position logic of its own to get wrong.
Verified in `attendance-ui.spec.ts` by comparing the first vs. last weekday
header cell's actual bounding-box X position (not just the `dir` attribute)
for both an LTR (US) and RTL (QA) member.

## 3. Accessibility

No new `accent-*`-on-`accent-*` text pairing was introduced: `design-system.md`'s
own contrast table never verified one, so the "live" badge/cell state uses
the already-verified `sky-50`/`sky-700` (info) tone for TEXT, and keeps
`accent-500` only for small, `aria-hidden`, purely decorative pulse dots.
`attendance-ui.spec.ts` runs the same axe-core (`wcag2a`/`wcag2aa`/`wcag21aa`)
light+dark scan `working-hours.spec.ts` established for `/working-hours`,
against `/attendance`.

## 4. Demo data

`seed:demo` now also clocks **Ivy Intern** (`intern@acme-demo.local`) IN
right now (an `OPEN` record started ~2h before the script runs) — in
addition to her existing ~30-day colourful history from Part 2 (which the
loop deliberately never touches "today"), so the live clock is immediately
demonstrable with zero manual steps. Idempotent: any pre-existing open
record for her is cleared first, so re-running the seed never leaves two.

**To see it**: `pnpm --filter @hrm/api run seed:demo`, sign in as
`intern@acme-demo.local` (password `DemoPass-123!`) and open `/dashboard` —
the live analog clock + goal ring are running. Open `/attendance` for her
colourful monthly graph. Sign in as `hr@acme-demo.local`/`ceo@acme-demo.local`
to use the manager/HR picker and view her month the same way. To put a
DIFFERENT demo user into a live state (e.g. after clocking Ivy back out),
either click "Clock in" on their own `/dashboard`, or run:

```ts
// one-off, e.g. via `pnpm --filter @hrm/api exec ts-node -e "..."` or a REPL
await prisma.attendanceRecord.create({
  data: { tenantId, employeeId, branchId, workDate: <today, UTC-midnight>, clockInAt: new Date(), clockInSource: 'WEB', status: 'OPEN' },
});
```

## 5. Known gaps / honest simplifications

- The clock widget queries a `[yesterday, today, tomorrow]` **browser-local**
  window and picks the `IN_PROGRESS` day if any, else browser-local "today" —
  the same "render in the viewer's own browser timezone" simplification
  `format.ts` already documents for display purposes. A member whose BRANCH
  timezone is far enough from their browser's that "today" disagrees by more
  than a day would see a stale idle state until the next poll; this never
  affects the server's own classification, only when the client notices it.
- The elapsed-time display is minute-grained (not second-grained) — only the
  decorative analog clock face itself ticks every second; re-rendering a
  "worked Xh Ym" string every second added nothing but noise.
- No department/holiday-name overlay on the calendar (the tooltip's reason
  text already says `HOLIDAY`/`WEEKEND`/`ON_LEAVE`; the specific holiday's
  own name isn't surfaced here — a possible follow-up, not required by this
  step's brief).
- Manager/HR picker options come from `GET /employees` (branch-scoped for a
  restricted caller), not a dedicated "who may I see via Part 2's reporting
  chain" listing (no such endpoint exists) — the picker may offer a name the
  status endpoint then 403s on for a MANAGER (not HR/admin); documented
  above as a deliberate "the UI offers, the API decides" choice, not a bug.

## Verification

See the 8.1 Part 3 entry in [BUILD_LOG.md](../BUILD_LOG.md).
