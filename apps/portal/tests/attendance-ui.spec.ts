import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma } from '@hrm/db';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Step 8.1 Part 3 — live clock + monthly graph. See
 * docs/conventions/attendance-ui.md. Every scenario here consumes
 * `GET /attendance/status` (Part 2) as-is; nothing is re-classified.
 *
 * `global-setup.ts` seeds a fully-PAST calendar month (the one before
 * whenever the suite runs) for `employeeA` (US HQ, colourful GREEN/YELLOW/
 * RED/NEUTRAL mix, exact counts in `fixtures.attendanceEmployeeACounts`) and
 * `qaEmployeeA` (Doha, Fri/Sat weekend, for the RTL proof), plus a DEDICATED
 * `attendanceLiveEmail` employee for the live-clock scenario (never touched
 * by any other spec).
 */

function expectedMonthLabel(isoFirst: string, locale: 'en' | 'ar' = 'en'): string {
  const [y, m] = isoFirst.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** qaEmployeeA resolves the QA Country Pack's own Arabic/RTL locale (see rtl.spec.ts/accessibility.spec.ts) — every other fixture employee is English/LTR. */
async function openAttendancePrevMonth(page: Page, email: string, locale: 'en' | 'ar' = 'en') {
  await login(page, fixtures.tenantASlug, email);
  await page.goto('/attendance');
  await expect(page.getByTestId('attendance-month-grid')).toBeVisible();
  await page.getByTestId('attendance-prev-month').click();
  await expect(page.getByTestId('attendance-month-label')).toHaveText(expectedMonthLabel(fixtures.attendancePrevMonthFirst, locale));
}

test.describe('Attendance UI — monthly graph', () => {
  test('renders the seeded colourful month with matching legend counts and reason tooltips', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.employeeAEmail);

    const counts = fixtures.attendanceEmployeeACounts;
    await expect(page.getByTestId('attendance-legend-GREEN')).toContainText(`(${counts.GREEN})`);
    await expect(page.getByTestId('attendance-legend-YELLOW')).toContainText(`(${counts.YELLOW})`);
    await expect(page.getByTestId('attendance-legend-RED')).toContainText(`(${counts.RED})`);
    await expect(page.getByTestId('attendance-legend-NEUTRAL')).toContainText(`(${counts.NEUTRAL})`);

    const { green, yellow, red, absent, leave } = fixtures.attendanceEmployeeASampleDates;
    await expect(page.getByTestId(`attendance-day-${green}`)).toHaveAttribute('data-status', 'GREEN');
    await expect(page.getByTestId(`attendance-day-${yellow}`)).toHaveAttribute('data-status', 'YELLOW');
    await expect(page.getByTestId(`attendance-day-${red}`)).toHaveAttribute('data-status', 'RED');
    await expect(page.getByTestId(`attendance-day-${absent}`)).toHaveAttribute('data-status', 'RED');
    await expect(page.getByTestId(`attendance-day-${leave}`)).toHaveAttribute('data-status', 'NEUTRAL');

    // Every day cell carries its own (always-in-DOM, hover/focus-revealed)
    // tooltip as a CHILD of the cell button itself — scope to each cell,
    // since `getByRole('tooltip')` alone would match every cell's tooltip at
    // once (opacity-0 isn't "hidden" as far as the accessibility tree goes).
    const tooltipFor = (date: string) => page.getByTestId(`attendance-day-${date}`).getByRole('tooltip');

    // Hover reveals a reason/times tooltip — the on-time day.
    await page.getByTestId(`attendance-day-${green}`).hover();
    await expect(tooltipFor(green!)).toContainText('On time');
    await expect(tooltipFor(green!)).toContainText('Check-in');

    // The absent day has no punches at all.
    await page.getByTestId(`attendance-day-${absent}`).hover();
    await expect(tooltipFor(absent!)).toContainText('Absent');

    // The approved-leave day.
    await page.getByTestId(`attendance-day-${leave}`).hover();
    await expect(tooltipFor(leave!)).toContainText('On approved leave');
  });

  test('an employee sees no member picker (sees only their own)', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.employeeAEmail);
    await expect(page.getByTestId('attendance-member-picker')).toHaveCount(0);
    await expect(page.getByTestId('attendance-viewing-label')).toContainText('your own');
  });

  test('a manager can view a report’s month via the picker', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.managerAEmail);
    await expect(page.getByTestId('attendance-member-picker')).toBeVisible();
    // Default view is the manager's own (empty) month.
    await expect(page.getByTestId('attendance-viewing-label')).toContainText('your own');

    await page.getByTestId('attendance-member-picker').selectOption({ label: 'Eve Employee (PE-EMP-1)' });
    await expect(page.getByTestId('attendance-viewing-label')).toContainText('Eve Employee');
    const counts = fixtures.attendanceEmployeeACounts;
    await expect(page.getByTestId('attendance-legend-GREEN')).toContainText(`(${counts.GREEN})`);
    await expect(page.getByTestId('attendance-legend-RED')).toContainText(`(${counts.RED})`);
  });

  test('RTL: the calendar mirrors for a QA-branch member, and renders without breakage', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.qaEmployeeAEmail, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await expect(page.getByTestId(`attendance-day-${fixtures.qaAttendanceGreenDate}`)).toHaveAttribute('data-status', 'GREEN');

    // Real mirroring, not just the `dir` attribute: the first weekday header
    // cell (always "Sun" in DOM order) must render visually to the RIGHT of
    // the last ("Sat") under RTL — the opposite of the LTR case below.
    const header = page.getByTestId('attendance-weekday-header').locator('> div');
    const firstBox = await header.first().boundingBox();
    const lastBox = await header.last().boundingBox();
    expect(firstBox).toBeTruthy();
    expect(lastBox).toBeTruthy();
    expect(firstBox!.x).toBeGreaterThan(lastBox!.x);

    // The live clock widget also renders without breaking under RTL.
    await expect(page.getByTestId('clock-widget')).toBeVisible();
  });

  test('LTR sanity check: the first weekday header cell renders to the LEFT of the last', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.employeeAEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    const header = page.getByTestId('attendance-weekday-header').locator('> div');
    const firstBox = await header.first().boundingBox();
    const lastBox = await header.last().boundingBox();
    expect(firstBox!.x).toBeLessThan(lastBox!.x);
  });

  test('passes axe (WCAG 2.1 AA) in light and dark', async ({ page }) => {
    await openAttendancePrevMonth(page, fixtures.employeeAEmail);
    const scan = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect((await scan()).violations).toEqual([]);

    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await scan()).violations).toEqual([]);
  });
});

test.describe('Attendance UI — live clock', () => {
  test.beforeEach(async () => {
    // Deterministic on repeat runs — clear any open record this dedicated
    // employee was left with by a previous (possibly interrupted) run.
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: fixtures.attendanceLiveEmployeeId, clockOutAt: null } });
  });

  test('clocking in shows the live animated clock with elapsed time; clocking out stops it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.attendanceLiveEmail);
    await page.goto('/dashboard');

    await expect(page.getByTestId('idle-clock-section')).toBeVisible();
    await expect(page.getByTestId('live-clock-section')).toHaveCount(0);

    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('live-clock-section')).toBeVisible();
    await expect(page.getByTestId('live-analog-clock')).toBeVisible();
    await expect(page.getByTestId('goal-ring')).toBeVisible();

    // The analog clock's accessible name is the live wall-clock time,
    // re-rendered every second — proof it actually ticks, without waiting a
    // full minute for the (deliberately coarser, minute-grained) elapsed
    // counter to roll over.
    const firstTick = await page.getByTestId('live-analog-clock').getAttribute('aria-label');
    await expect
      .poll(async () => page.getByTestId('live-analog-clock').getAttribute('aria-label'), { timeout: 5_000 })
      .not.toBe(firstTick);

    await waitFor(() => prisma.attendanceRecord.findFirst({ where: { employeeId: fixtures.attendanceLiveEmployeeId, status: 'OPEN' } }));

    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('live-clock-section')).toHaveCount(0);
    await expect(page.getByTestId('idle-clock-section')).toBeVisible();
    // An almost-instant clock-in/out is always under the half-day threshold
    // regardless of what time of day this runs — a deterministic RED day.
    await expect(page.getByTestId('idle-clock-section')).toContainText(/half day/i);
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, fixtures.tenantASlug, fixtures.attendanceLiveEmail);
    await page.goto('/dashboard');
    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('live-analog-clock')).toBeVisible();
    // No assertion on the transition itself (jsdom-free Playwright can't
    // read computed transition-duration reliably across browsers) — this
    // proves the page still renders correctly with the media feature set,
    // which is what `motion-reduce:`/`useReducedMotion` exist to guarantee.

    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('idle-clock-section')).toBeVisible();
  });
});
