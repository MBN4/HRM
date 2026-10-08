import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Step 8.1 Part 3 — live analog clock + colour-coded monthly graph (docs/conventions/attendance-ui.md).
 * Real API, real DB: the colours asserted are whatever `GET /attendance/status` (Part 2) returns for months
 * seeded in global-setup — nothing is mocked or computed client-side.
 */
test.describe.configure({ mode: 'serial' });

const STATUSES = ['GREEN', 'YELLOW', 'RED', 'NEUTRAL', 'IN_PROGRESS'] as const;

async function openAttendance(page: Page) {
  // In-app navigation (a full page.goto re-runs the rate-limited token refresh and flakes).
  await page.locator('aside a[href="/attendance"]').click();
  await expect(page.getByTestId('attendance-page')).toBeVisible();
}

async function gotoPrevMonth(page: Page) {
  const graph = page.getByTestId('attendance-month-card').getByTestId('monthly-graph');
  await expect(graph).toBeVisible();
  // The graph may first render the browser's month and re-anchor to the branch's — wait for it to settle.
  await expect(page.getByTestId('month-grid').locator('button[data-testid^="day-"]').first()).toBeVisible();
  await page.getByTestId('month-prev').click();
  await expect(graph).toHaveAttribute('data-month', fixtures.prevMonthKey);
  await expect(page.getByTestId(`day-${fixtures.prevMonthKey}-02`)).toBeVisible();
}

async function cellStates(page: Page): Promise<Record<string, { status: string; reason: string }>> {
  return page.locator('[data-testid^="day-2"]').evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.getAttribute('data-testid')!.slice(4), { status: e.getAttribute('data-status')!, reason: e.getAttribute('data-reason')! }])),
  );
}

test.describe('live analog clock', () => {
  test('a member already clocked in sees the clock ticking, elapsed running and the goal ring filling', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.livEmail);
    const live = page.getByTestId('clock-live');
    await expect(live).toBeVisible();
    await expect(page.getByTestId('analog-clock')).toHaveAttribute('data-live', 'true');

    // Elapsed is anchored to the SERVER clock-in (~2h ago), not to when the page opened.
    const elapsed = page.getByTestId('clock-elapsed');
    await expect(elapsed).toHaveText(/^02:\d\d:\d\d$/);
    const first = await elapsed.textContent();
    const secondDeg1 = await page.getByTestId('second-hand').getAttribute('data-second-deg');
    await page.waitForTimeout(2200);
    expect(await elapsed.textContent()).not.toBe(first);
    expect(await page.getByTestId('second-hand').getAttribute('data-second-deg')).not.toBe(secondDeg1);

    // 2h of an (up to) 8h goal — a partially filled ring and a remaining-time readout.
    const progress = Number(await page.getByTestId('clock-progress-ring').getAttribute('data-progress'));
    expect(progress).toBeGreaterThan(0.15);
    expect(progress).toBeLessThan(0.5);
    await expect(page.getByTestId('clock-remaining')).toContainText(/to go/i);
    await page.screenshot({ path: 'test-results/attendance-ui-live-clock-light.png', fullPage: true });
  });

  test('clocking out stops the clock and shows today\'s resulting status (short day => Half day)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.livEmail);
    await expect(page.getByTestId('clock-live')).toBeVisible();
    await page.getByTestId('clock-toggle-button').click();

    const idle = page.getByTestId('clock-idle');
    await expect(idle).toBeVisible();
    await expect(page.getByTestId('clock-live')).toHaveCount(0);
    await expect(idle).toHaveAttribute('data-state', 'done');
    const status = await page.getByTestId('clock-day-status').getAttribute('data-status');
    expect(['RED', 'NEUTRAL']).toContain(status); // RED normally; NEUTRAL only if the suite happens to run on a weekend/holiday
    if (status === 'RED') await expect(page.getByTestId('clock-shortfall')).toHaveAttribute('data-kind', 'HALF_DAY');
    // The dashboard's own month graph picked up the clock-out too (today's cell is no longer in progress).
    await expect(page.getByTestId('dashboard-month-card').locator('[data-status="IN_PROGRESS"]')).toHaveCount(0);
  });

  test('clock IN through the UI starts the live clock, then OUT ends it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.clayEmail);
    await expect(page.getByTestId('clock-idle')).toBeVisible();
    await expect(page.getByTestId('analog-clock')).toHaveAttribute('data-live', 'false');
    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('clock-live')).toBeVisible();
    await expect(page.getByTestId('clock-elapsed')).toHaveText(/^00:00:\d\d$/);
    await expect(page.getByTestId('dashboard-month-card').locator('[data-status="IN_PROGRESS"]')).toHaveCount(1);
    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('clock-idle')).toHaveAttribute('data-state', 'done');
  });

  test('prefers-reduced-motion: the second hand ticks in whole seconds (no sweep), nothing pulses', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await login(page, fixtures.tenantASlug, fixtures.clayEmail); // clocked out already -> idle clock
    await expect(page.getByTestId('analog-clock')).toBeVisible();
    for (let i = 0; i < 3; i += 1) {
      const deg = Number(await page.getByTestId('second-hand').getAttribute('data-second-deg'));
      expect(deg % 6).toBeCloseTo(0, 1);
      await page.waitForTimeout(700);
    }
    await expect(page.locator('[data-testid="analog-clock"] .animate-pulse')).toHaveCount(0);
    await context.close();
  });
});

test.describe('monthly graph', () => {
  test('renders the seeded colourful month: right colours, legend = cell counts, reasons + times in tooltips', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.ginaEmail);
    // the dashboard carries a compact graph too
    await expect(page.getByTestId('dashboard-month-card').getByTestId('monthly-graph')).toBeVisible();
    await openAttendance(page);
    await gotoPrevMonth(page);

    const states = await cellStates(page);
    const dates = Object.keys(states);
    expect(dates.length).toBeGreaterThanOrEqual(28);

    // Every seeded working day is coloured by the SERVER's classification of that day (a pack holiday overrides to NEUTRAL).
    for (const s of fixtures.ginaSeeded) {
      const cell = states[s.date];
      expect(cell, s.date).toBeTruthy();
      if (cell.reason === 'HOLIDAY') {
        expect(cell.status).toBe('NEUTRAL');
        continue;
      }
      expect(cell.status, `${s.date} (${s.kind})`).toBe(s.status);
    }

    // Weekends come back NEUTRAL from the API (US: Sat/Sun) — distinct from green AND red.
    for (const d of dates) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) expect(states[d].status, d).toBe('NEUTRAL');
    }

    // Legend counts == what is painted == total days.
    const painted: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const d of dates) painted[states[d].status] += 1;
    for (const s of ['GREEN', 'YELLOW', 'RED', 'NEUTRAL'] as const) {
      await expect(page.getByTestId(`legend-${s}`)).toHaveAttribute('data-count', String(painted[s]));
    }
    expect(painted.GREEN).toBeGreaterThan(0);
    expect(painted.YELLOW).toBeGreaterThan(0);
    expect(painted.RED).toBeGreaterThan(0);
    expect(painted.NEUTRAL).toBeGreaterThanOrEqual(8);
    expect(Object.values(painted).reduce((a, b) => a + b, 0)).toBe(dates.length);

    // A late-beyond-grace day: tooltip shows the human-readable reason, in/out times and hours vs required.
    const late = fixtures.ginaSeeded.find((s) => s.kind === 'R' && states[s.date]?.reason !== 'HOLIDAY')!;
    await page.getByTestId(`day-${late.date}`).hover();
    const tip = page.getByTestId(`day-tooltip-${late.date}`);
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Late beyond the grace period');
    await expect(tip).toContainText(/\d{1,2}:\d{2}/);
    await expect(tip).toContainText(/h of 8\.0 h/);
    await expect(tip).toContainText('65 min');
    // ...and a green one reads "On time", a weekend "Weekend".
    const green = fixtures.ginaSeeded.find((s) => s.kind === 'G' && states[s.date]?.reason !== 'HOLIDAY')!;
    await page.getByTestId(`day-${green.date}`).hover();
    await expect(page.getByTestId(`day-tooltip-${green.date}`)).toContainText('On time');
    const weekend = dates.find((d) => states[d].reason === 'WEEKEND')!;
    await page.getByTestId(`day-${weekend}`).hover();
    await expect(page.getByTestId(`day-tooltip-${weekend}`)).toContainText('Weekend');
    await page.screenshot({ path: 'test-results/attendance-ui-month-light.png', fullPage: true });

    // Month navigation: forward again lands on the current month, and "This month" appears/disappears accordingly.
    await expect(page.getByTestId('month-today')).toBeVisible();
    await page.getByTestId('month-today').click();
    await expect(page.getByTestId('month-today')).toHaveCount(0);
  });

  test('light and dark are both polished: distinct token colours, no a11y violations, screenshots', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.ginaEmail);
    await openAttendance(page);
    await gotoPrevMonth(page);
    const states = await cellStates(page);
    const greenDate = Object.keys(states).find((d) => states[d].status === 'GREEN')!;
    const redDate = Object.keys(states).find((d) => states[d].status === 'RED')!;
    const bg = (date: string) => page.getByTestId(`day-${date}`).evaluate((el) => getComputedStyle(el).backgroundColor);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
      const g = await bg(greenDate);
      const r = await bg(redDate);
      expect(g).not.toBe(r);
      const results = await new AxeBuilder({ page }).include('[data-testid="attendance-month-card"]').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
      await page.screenshot({ path: `test-results/attendance-ui-month-${scheme}.png`, fullPage: true });
    }
  });
});

test.describe('RTL (QA branch)', () => {
  test('the calendar mirrors: week starts on the right, Fri/Sat neutral from the server, tooltip stays on screen', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qadirEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await openAttendance(page);
    await gotoPrevMonth(page);

    // Header order is logical (Sunday first) but PLACED from the right under RTL.
    const heads = page.getByTestId('month-grid').getByRole('columnheader');
    await expect(heads).toHaveCount(7);
    const firstBox = (await heads.nth(0).boundingBox())!;
    const lastBox = (await heads.nth(6).boundingBox())!;
    expect(firstBox.x).toBeGreaterThan(lastBox.x);

    // Day 1 is in the same week row as its weekday header, in its mirrored column.
    const states = await cellStates(page);
    const dates = Object.keys(states);
    const first = dates[0];
    const dow = new Date(`${first}T00:00:00Z`).getUTCDay();
    const cellBox = (await page.getByTestId(`day-${first}`).boundingBox())!;
    const headBox = (await heads.nth(dow).boundingBox())!;
    expect(Math.abs(cellBox.x + cellBox.width / 2 - (headBox.x + headBox.width / 2))).toBeLessThan(headBox.width);

    // Qatar's weekend is Fri/Sat — straight from the API, not hardcoded in the UI.
    for (const d of dates) {
      const day = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (day === 5 || day === 6) expect(states[d].reason, d).toBe('WEEKEND');
      else if (states[d].reason !== 'HOLIDAY') expect(states[d].reason, d).not.toBe('WEEKEND');
    }
    // Seeded working days (Sun-Thu) are classified like any other.
    for (const s of fixtures.qadirSeeded) {
      if (states[s.date].reason !== 'HOLIDAY') expect(states[s.date].status, s.date).toBe(s.status);
    }

    // A tooltip on the first-column (right-most) cell stays inside the viewport.
    const tipDate = dates.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0 && states[d].status !== 'NEUTRAL') ?? dates[1];
    await page.getByTestId(`day-${tipDate}`).hover();
    const tip = page.getByTestId(`day-tooltip-${tipDate}`);
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/[\u0600-\u06FF]/); // Arabic reason text
    const tb = (await tip.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(tb.x).toBeGreaterThanOrEqual(0);
    expect(tb.x + tb.width).toBeLessThanOrEqual(vp.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/attendance-ui-month-rtl.png', fullPage: true });
  });

  test('the dashboard clock + graph render right-to-left without breakage, in dark too', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qadirEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('analog-clock')).toBeVisible();
    await expect(page.getByTestId('dashboard-month-card').getByTestId('monthly-graph')).toBeVisible();
    // The clock face is deliberately NOT mirrored (clockwise everywhere): "12" stays at the top.
    const card = (await page.getByTestId('dashboard-clock-card').boundingBox())!;
    const clock = (await page.getByTestId('analog-clock').boundingBox())!;
    expect(clock.x).toBeGreaterThanOrEqual(card.x);
    expect(clock.x + clock.width).toBeLessThanOrEqual(card.x + card.width);
    // Under RTL the clock sits on the inline START = the right side of the card's content.
    expect(clock.x + clock.width / 2).toBeGreaterThan(card.x + card.width / 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await expect(page.getByTestId('analog-clock')).toBeVisible();
  });
});

test.describe('who sees whom', () => {
  test('an employee sees only their own month — no member picker', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await openAttendance(page);
    await expect(page.getByTestId('attendance-month-card').getByTestId('monthly-graph')).toBeVisible();
    await expect(page.getByTestId('attendance-member-select')).toHaveCount(0);
  });

  test('a manager picks a report and sees that person\'s month; someone outside their chain is refused by the API', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openAttendance(page);
    const select = page.getByTestId('attendance-member-select');
    await expect(select).toHaveCount(1);
    await select.selectOption({ label: `${fixtures.ginaName} (${fixtures.ginaEmployeeCode})` });
    await gotoPrevMonth(page);
    const states = await cellStates(page);
    const g = fixtures.ginaSeeded.find((s) => s.kind === 'R' && states[s.date]?.reason !== 'HOLIDAY')!;
    expect(states[g.date].status).toBe('RED');
    expect(states[g.date].reason).toBe('LATE_BEYOND_GRACE');

    // Wanda Hours has no manager => not in this manager's reporting chain => 403 from Part 2, shown as a clear message.
    await select.selectOption({ label: `${fixtures.whEmployeeName} (${fixtures.whEmployeeCode})` });
    await expect(page.getByText('You can only view attendance for yourself and the people who report to you.')).toBeVisible();
    // Back to "Me".
    await select.selectOption({ label: 'Me' });
    await expect(page.getByText('You can only view attendance for yourself')).toHaveCount(0);
  });
});
