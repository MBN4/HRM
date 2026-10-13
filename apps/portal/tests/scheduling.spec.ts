import { readFileSync } from 'fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';
import { addDays, API, apiHeaders, cleanup, createShift, publish, setCells, weekStartOf, ymdLocal } from './scheduling-helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Step 8.2 — Shift scheduling & rostering UI (docs/conventions/shift-scheduling.md). Real API, real DB: shifts and the
 * roster are created through the API (admin) or the UI under test, never mocked; afterAll wipes every cell/shift it made.
 * Serial: later tests build on the roster the earlier ones wrote (copy -> publish -> employee sees it -> swap).
 */
test.describe.configure({ mode: 'serial' });

const thisWeek = weekStartOf(ymdLocal());
const nextWeek = addDays(thisWeek, 7);
const WINDOW_END = addDays(nextWeek, 13);

let earlyId = '';
let lateId = '';
let nightId = '';
let admin: Record<string, string>;
let request: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext();
  admin = await apiHeaders(request, fixtures, fixtures.adminAEmail);
  earlyId = (await createShift(request, admin, { name: 'E2E Early', startTime: '06:00', endTime: '14:00', color: '#2563eb', minStaffing: 2 })).id;
  lateId = (await createShift(request, admin, { name: 'E2E Late', startTime: '16:00', endTime: '01:00', color: '#d97706' })).id;
  nightId = (await createShift(request, admin, { name: 'E2E Night', startTime: '22:00', endTime: '06:00', color: '#7c3aed' })).id;
  // The SOURCE week for "Copy last week": Rita on Early for the first two days of the current week (admin may write past days).
  await setCells(request, admin, [
    { employeeId: fixtures.ritaEmployeeId, date: addDays(nextWeek, -7), shiftDefinitionId: earlyId },
    { employeeId: fixtures.ritaEmployeeId, date: addDays(nextWeek, -6), shiftDefinitionId: earlyId },
  ]);
  // Sam also works Early on the first day of next week, so that day has 2/2 (no gap) while the others are understaffed.
  await setCells(request, admin, [{ employeeId: fixtures.samEmployeeId, date: nextWeek, shiftDefinitionId: earlyId }]);
});

test.afterAll(async () => {
  await cleanup(request, admin, [fixtures.ritaEmployeeId, fixtures.samEmployeeId, fixtures.tiaEmployeeId, fixtures.qaReportEmployeeId], addDays(thisWeek, -7), WINDOW_END, [earlyId, lateId, nightId]);
  await request.dispose();
});

const cell = (page: Page, employeeId: string, date: string) => page.getByTestId(`roster-cell-${employeeId}-${date}`);

async function openRoster(page: Page) {
  await page.locator('aside a[href="/scheduling"]').click();
  await expect(page.getByTestId('roster-grid')).toBeVisible();
}

async function gotoNextWeek(page: Page) {
  await page.getByTestId('window-next').click();
  await expect(page.getByTestId('window-title')).toHaveAttribute('data-from', nextWeek);
  await expect(page.getByTestId('roster-grid')).toBeVisible();
}

test.describe('manager: roster calendar', () => {
  test('sees only their reports; past days are read-only for a manager', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await expect(page.getByTestId(`roster-row-${fixtures.ritaEmployeeCode}`)).toBeVisible();
    // Mona's own row is not in her grid (you are not your own report); the admin/other-chain people are absent too.
    await expect(page.getByTestId('roster-row-PE-MGR-1')).toHaveCount(0);
    await expect(page.getByTestId('roster-row-PE-WH-1')).toHaveCount(0);

    // Previous week: every cell is read-only for a manager, and clicking one opens nothing.
    await page.getByTestId('window-prev').click();
    await expect(page.getByTestId('window-title')).toHaveAttribute('data-from', addDays(thisWeek, -7));
    const past = cell(page, fixtures.ritaEmployeeId, addDays(thisWeek, -7));
    await expect(past).toHaveAttribute('data-editable', 'false');
    await expect(past).toHaveAttribute('aria-disabled', 'true');
    await past.click({ force: true });
    await expect(page.getByTestId('assign-modal')).toHaveCount(0);
  });

  test('assigns a shift via the editor (a draft), copies last week, then publishes with a confirmation', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await gotoNextWeek(page);
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '1'); // Sam's API-created (draft) Early cell

    // The shift legend names the tenant's shifts, with an overnight marker on 16:00–01:00.
    const legend = page.getByTestId('roster-legend');
    await expect(legend).toContainText('E2E Early');
    await expect(legend.locator('[data-overnight="true"]').first()).toBeVisible();

    // Assign Rita -> Late on the third day through the cell editor.
    const target = addDays(nextWeek, 2);
    await cell(page, fixtures.ritaEmployeeId, target).click();
    await expect(page.getByTestId('assign-modal')).toBeVisible();
    await page.getByTestId(`assign-shift-${lateId}`).check();
    await page.getByTestId('assign-apply').click();
    await expect(page.getByTestId('assign-modal')).toHaveCount(0);
    await expect(cell(page, fixtures.ritaEmployeeId, target)).toHaveAttribute('data-shift', lateId);
    await expect(cell(page, fixtures.ritaEmployeeId, target)).toHaveAttribute('data-status', 'DRAFT');
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '2');

    // Copy last week -> Rita's two Early days land on the same weekdays, as drafts.
    await page.getByTestId('copy-last-week').click();
    await expect(page.getByTestId('roster-notice')).toContainText(/Copied 2 entries/);
    await expect(cell(page, fixtures.ritaEmployeeId, nextWeek)).toHaveAttribute('data-shift', earlyId);
    await expect(cell(page, fixtures.ritaEmployeeId, addDays(nextWeek, 1))).toHaveAttribute('data-shift', earlyId);
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '4');

    // Publish: the confirmation states how many drafts; afterwards nothing is a draft.
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('dialog')).toContainText('4 draft entries');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('roster-notice')).toContainText(/Published 4 entries/);
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '0');
    await expect(cell(page, fixtures.ritaEmployeeId, target)).toHaveAttribute('data-status', 'PUBLISHED');
  });

  test('multi-select: a row fill + a range select assign a day off to several cells at once', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await gotoNextWeek(page);
    // Tia has no entries: select the first three days with click + shift-click, then assign a day off.
    const a = cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, 1));
    await a.click();
    await expect(page.getByTestId('assign-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assign-modal')).toHaveCount(0);
    await cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, 1)).click({ modifiers: ['Shift'] });
    await cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, 3)).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-count')).toContainText('3 selected');
    await page.getByTestId('selection-assign').click();
    await page.getByTestId('assign-dayoff').check();
    await page.getByTestId('assign-apply').click();
    for (const i of [1, 2, 3]) await expect(cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, i))).toHaveAttribute('data-kind', 'DAY_OFF');
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '3');
    // Whole-row select button selects every editable day of the row.
    await page.getByTestId(`roster-fill-row-PE-SW-2`).click();
    await expect(page.getByTestId('selection-count')).toContainText('7 selected');
    await page.getByTestId('selection-clear').click();
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);

    // Publishing makes Tia's days off live; then clear them again (editing a published cell is live immediately).
    await page.getByTestId('publish-button').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('draft-count')).toHaveAttribute('data-count', '0');
    await cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, 1)).click();
    await expect(page.getByTestId('assign-modal')).toContainText('already published');
    await page.getByTestId('assign-clear').check();
    await page.getByTestId('assign-apply').click();
    await expect(cell(page, fixtures.tiaEmployeeId, addDays(nextWeek, 1))).not.toHaveAttribute('data-kind', 'DAY_OFF');
  });

  test('an API error is shown in a visible alert (the shift was deleted under the editor)', async ({ page }) => {
    const doomed = await createShift(request, admin, { name: 'E2E Doomed', startTime: '10:00', endTime: '18:00' });
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await gotoNextWeek(page);
    await cell(page, fixtures.ritaEmployeeId, addDays(nextWeek, 5)).click();
    await page.getByTestId(`assign-shift-${doomed.id}`).check();
    await request.delete(`${API}/scheduling/shifts/${doomed.id}`, { headers: admin });
    await page.getByTestId('assign-apply').click();
    await expect(page.getByTestId('assign-error')).toContainText(/shift/i);
    await expect(page.getByTestId('assign-modal')).toBeVisible(); // stays open so the user can pick again
  });
});

test.describe('keyboard + other screens fed by the roster', () => {
  test('the roster grid is keyboard operable: arrow keys move between cells, Enter opens the editor, Escape closes it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await gotoNextWeek(page);
    const first = cell(page, fixtures.ritaEmployeeId, nextWeek);
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(cell(page, fixtures.ritaEmployeeId, addDays(nextWeek, 1))).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(cell(page, fixtures.ritaEmployeeId, addDays(nextWeek, 2))).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(cell(page, fixtures.ritaEmployeeId, addDays(nextWeek, 1))).toBeFocused();
    // Every cell has an accessible name carrying who / which day / what.
    await expect(cell(page, fixtures.ritaEmployeeId, nextWeek)).toHaveAccessibleName(/Rita Roster.*E2E Early 06:00–14:00/);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('assign-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assign-modal')).toHaveCount(0);
  });

  test('the working-hours "effective policy" card reports the ROSTER source and the shift for a published day', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.locator('aside a[href="/working-hours"]').click();
    await expect(page.getByTestId('wh-company-form')).toBeVisible();
    await page.getByTestId('wh-effective-member').selectOption({ label: 'Rita Roster (PE-RR-1)' });
    await page.getByTestId('wh-effective-date').fill(nextWeek);
    await expect(page.getByTestId('wh-effective-source')).toHaveAttribute('data-source', 'ROSTER');
    await expect(page.getByTestId('wh-effective-shift')).toContainText('Shift: E2E Early');
    await expect(page.getByTestId('wh-effective-start')).toHaveText('06:00');
  });
});

test.describe('manager: coverage + shifts + standing', () => {
  test('coverage shows the understaffed days (colour + icon + text) and the covered one', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await gotoNextWeek(page);
    await page.getByTestId('scheduling-tab-coverage').click();
    await expect(page.getByTestId('coverage-table')).toBeVisible();
    // Early needs 2: day 0 has Sam + Rita (covered), day 1 only Rita (a gap).
    const covered = page.getByTestId(`coverage-cell-${earlyId}-${nextWeek}`);
    const gap = page.getByTestId(`coverage-cell-${earlyId}-${addDays(nextWeek, 1)}`);
    await expect(covered).toHaveAttribute('data-gap', 'false');
    await expect(covered).toHaveAttribute('data-count', '2');
    await expect(gap).toHaveAttribute('data-gap', 'true');
    await expect(gap).toContainText('1 / 2');
    await expect(gap).toContainText(/short/i);
    await expect(page.getByTestId('coverage-gaps-summary')).toBeVisible();
    await gap.click();
    await expect(page.getByTestId('coverage-detail')).toContainText('Rita Roster');
    await expect(page.getByTestId('coverage-detail')).toContainText(/Understaffed/);
  });

  test('a manager sees the shifts read-only and can only set standing shifts for members', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await openRoster(page);
    await page.getByTestId('scheduling-tab-shifts').click();
    await expect(page.getByTestId('shifts-table')).toContainText('E2E Early');
    await expect(page.getByTestId('shift-add')).toHaveCount(0);
    await expect(page.getByTestId('shift-usage-E2E Early')).toContainText('roster');
    await page.getByTestId('scheduling-tab-standing').click();
    await expect(page.getByTestId('standing-add-member')).toBeVisible();
    await expect(page.getByTestId('standing-teams')).toHaveCount(0);
  });

  test('HR/admin defines a shift (overnight hint + derived hours), edits it, sets and clears a standing shift, and a 409 delete shows its message', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.locator('aside a[href="/scheduling"]').click();
    await page.getByTestId('scheduling-tab-shifts').click();
    await page.getByTestId('shift-add').click();
    await page.getByTestId('shift-name').fill('E2E Swing');
    await page.getByTestId('shift-start').fill('20:00');
    await page.getByTestId('shift-end').fill('04:00');
    await page.getByTestId('shift-break').fill('30');
    await expect(page.getByTestId('shift-form')).toContainText('ends the next day');
    await expect(page.getByTestId('shift-derived')).toContainText('Required 8 h = 7.5 h work + 0.5 h break');
    await page.getByTestId('shift-min').fill('1');
    await page.getByTestId('shift-save').click();
    await expect(page.getByTestId('shift-row-E2E Swing')).toBeVisible();
    await expect(page.getByTestId('shift-row-E2E Swing').locator('[data-overnight="true"]')).toBeVisible();

    await page.getByTestId('shift-edit-E2E Swing').click();
    await page.getByTestId('shift-grace').fill('5');
    await page.getByTestId('shift-save').click();
    await expect(page.getByTestId('shift-row-E2E Swing')).toContainText('5 min');

    // Standing: set it for Rita (member), see it listed, clear it.
    await page.getByTestId('scheduling-tab-standing').click();
    await expect(page.getByTestId('standing-teams')).toBeVisible(); // tenant-wide authority sees company + team cards
    await page.getByTestId('standing-add-member').click();
    await page.getByTestId('standing-member').selectOption({ label: 'Rita Roster (PE-RR-1)' });
    await page.getByTestId('standing-shift').selectOption({ label: 'E2E Swing (20:00–04:00)' });
    await page.getByTestId('standing-save').click();
    await expect(page.getByTestId('standing-member-row-PE-RR-1')).toContainText('E2E Swing');
    // ...which now blocks deleting the shift (409), with the server's message shown.
    await page.getByTestId('scheduling-tab-shifts').click();
    await page.getByTestId('shift-delete-E2E Swing').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByRole('dialog')).toContainText(/assign|in use|used/i);
    await page.keyboard.press('Escape');
    await page.getByTestId('scheduling-tab-standing').click();
    await page.getByTestId('standing-clear-member-PE-RR-1').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('standing-member-row-PE-RR-1')).toHaveCount(0);
    // Now it deletes cleanly.
    await page.getByTestId('scheduling-tab-shifts').click();
    await page.getByTestId('shift-delete-E2E Swing').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('shift-row-E2E Swing')).toHaveCount(0);
  });
});

test.describe('employee: my schedule, dashboard card, swap', () => {
  test('sees the published roster on /schedule (rostered vs standing, overnight marker) and a dashboard card', async ({ page }) => {
    // One overnight day so the marker has something to show; published so the employee sees it.
    await setCells(request, admin, [{ employeeId: fixtures.ritaEmployeeId, date: addDays(nextWeek, 3), shiftDefinitionId: nightId }]);
    await publish(request, admin, nextWeek, addDays(nextWeek, 6));

    await login(page, fixtures.tenantASlug, fixtures.ritaEmail);
    await expect(page.getByTestId('upcoming-shifts-card')).toBeVisible();
    await expect(page.getByTestId(`upcoming-shift-${nextWeek}`)).toContainText('E2E Early');
    await page.locator('aside a[href="/schedule"]').click();
    await expect(page.getByTestId('my-schedule-page')).toBeVisible();
    const day = page.getByTestId(`schedule-day-${nextWeek}`);
    await expect(day).toHaveAttribute('data-kind', 'SHIFT');
    await expect(day).toHaveAttribute('data-via', 'ROSTER');
    await expect(day).toContainText('06:00–14:00');
    const night = page.getByTestId(`schedule-day-${addDays(nextWeek, 3)}`);
    await expect(night).toHaveAttribute('data-overnight', 'true');
    await expect(night).toContainText('E2E Night');
    // A plain employee has no manager navigation.
    await expect(page.locator('aside a[href="/scheduling"]')).toHaveCount(0);
  });

  test('swap: Sam requests, Tia accepts, the manager approves in /approvals, and the rosters trade', async ({ browser }) => {
    const day = addDays(nextWeek, 4);
    await setCells(request, admin, [
      { employeeId: fixtures.samEmployeeId, date: day, shiftDefinitionId: earlyId },
      { employeeId: fixtures.tiaEmployeeId, date: day, shiftDefinitionId: lateId },
    ]);
    await publish(request, admin, day, day);

    const ctx = async (email: string) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await login(page, fixtures.tenantASlug, email);
      await page.locator('aside a[href="/schedule"]').click();
      await expect(page.getByTestId('my-schedule-page')).toBeVisible();
      return { context, page };
    };

    // Sam requests the swap.
    const sam = await ctx(fixtures.samEmail);
    try {
      await sam.page.getByTestId(`schedule-swap-btn-${day}`).click();
      await sam.page.getByTestId('swap-colleague').selectOption({ label: 'Tia Trade' });
      await sam.page.getByTestId('swap-reason').fill('Doctor appointment');
      await sam.page.getByTestId('swap-send').click();
      await expect(sam.page.getByTestId('schedule-notice')).toBeVisible();
      await expect(sam.page.getByTestId(`schedule-swap-${day}`)).toContainText('Awaiting colleague');
      await expect(sam.page.getByTestId('swaps-mine-list').locator('[data-status="AWAITING_PEER"]')).toHaveCount(1);
    } finally {
      await sam.context.close();
    }

    // Tia accepts.
    const tia = await ctx(fixtures.tiaEmail);
    try {
      await tia.page.locator('[data-testid^="swap-accept-"]').first().click();
      await expect(tia.page.locator('[data-testid^="swap-status-"]').first()).toContainText('Awaiting manager');
      await expect(tia.page.getByRole('link', { name: /approves this in Approvals/ })).toBeVisible();
    } finally {
      await tia.context.close();
    }

    // The manager sees it as a ShiftSwap approval card and approves it (the generic workflow engine — no bespoke button).
    const mgr = await browser.newContext();
    try {
      const page = await mgr.newPage();
      await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
      await page.locator('aside a[href="/approvals"]').click();
      const card = page.locator('[data-testid="approval-card"][data-entity-type="ShiftSwap"]').first();
      await expect(card).toBeVisible();
      await expect(card).toContainText('Shift swap');
      await Promise.all([page.waitForResponse((r) => r.url().includes('/actions') && r.request().method() === 'POST' && r.ok()), card.getByTestId('approve-button').click()]);
      // The approval listener rewrites both rosters; poll Sam's schedule until it shows the trade.
      const samHeaders = await apiHeaders(request, fixtures, fixtures.samEmail);
      const traded = await waitFor(async () => {
        const res = await request.get(`${API}/scheduling/my-schedule`, { headers: samHeaders, params: { from: day, to: day } });
        const body = (await res.json()) as { days: { shift: { name: string } | null }[] };
        return body.days[0]?.shift?.name === 'E2E Late';
      }, 20000);
      expect(traded).toBe(true);
      // Manager's team swap list shows it as approved.
      await page.locator('aside a[href="/schedule"]').click();
      await expect(page.getByTestId('team-swap-requests').locator('[data-status="APPROVED"]')).toHaveCount(1);
    } finally {
      await mgr.close();
    }
  });
});

test.describe('attendance graph picks up the roster', () => {
  test('a published rostered day off is a NEUTRAL "Rostered day off" cell and a shifted day names its shift in the tooltip', async ({ page }) => {
    const today = ymdLocal();
    const month = today.slice(0, 7);
    const shiftDay = addDays(today, -1).startsWith(month) ? addDays(today, -1) : addDays(today, 1);
    await setCells(request, admin, [
      { employeeId: fixtures.ritaEmployeeId, date: today, dayOff: true },
      { employeeId: fixtures.ritaEmployeeId, date: shiftDay, shiftDefinitionId: earlyId },
    ]);
    const [lo, hi] = [today, shiftDay].sort();
    await publish(request, admin, lo, hi);

    await login(page, fixtures.tenantASlug, fixtures.ritaEmail);
    await page.locator('aside a[href="/attendance"]').click();
    await expect(page.getByTestId('attendance-page')).toBeVisible();
    const grid = page.getByTestId('attendance-month-card').getByTestId('monthly-graph');
    const off = grid.getByTestId(`day-${today}`);
    await expect(off).toHaveAttribute('data-reason', 'DAY_OFF');
    await expect(off).toHaveAttribute('data-status', 'NEUTRAL');
    await off.focus();
    await expect(grid.getByTestId(`day-tooltip-${today}`)).toContainText('Rostered day off');
    await grid.getByTestId(`day-${shiftDay}`).focus();
    await expect(grid.getByTestId(`day-shift-${shiftDay}`)).toContainText('E2E Early');
  });
});

test.describe('RTL: a QA-branch (Doha / Arabic) scheduler and employee', () => {
  test('the roster calendar mirrors: dir=rtl, the employee column sits on the right, days run right-to-left, Fri/Sat are the weekend', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaManagerEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('aside a[href="/scheduling"]').click();
    await expect(page.getByTestId('roster-grid')).toBeVisible();
    await expect(page.getByTestId(`roster-row-${fixtures.qaReportEmployeeCode}`)).toBeVisible();

    const from = (await page.getByTestId('window-title').getAttribute('data-from'))!;
    const firstDay = await page.getByTestId(`roster-col-${from}`).boundingBox();
    const lastDay = await page.getByTestId(`roster-col-${addDays(from, 6)}`).boundingBox();
    const nameCol = await page.getByTestId(`roster-row-${fixtures.qaReportEmployeeCode}`).locator('[role="rowheader"]').boundingBox();
    expect(firstDay!.x).toBeGreaterThan(lastDay!.x); // day 0 is on the right
    expect(nameCol!.x).toBeGreaterThan(firstDay!.x); // ...and the sticky employee column is at the inline-start (right) edge

    // Qatar's weekend (Friday = +5, Saturday = +6) comes from the branch's Country Pack, not from the UI.
    await expect(cell(page, fixtures.qaReportEmployeeId, addDays(from, 5))).toHaveAttribute('data-kind', 'WEEKEND');
    await expect(cell(page, fixtures.qaReportEmployeeId, addDays(from, 6))).toHaveAttribute('data-kind', 'WEEKEND');
    await expect(cell(page, fixtures.qaReportEmployeeId, addDays(from, 1))).not.toHaveAttribute('data-kind', 'WEEKEND');
    // Arabic chrome.
    await expect(page.getByTestId('publish-button')).toContainText('نشر');
    await page.screenshot({ path: 'test-results/scheduling-roster-rtl.png', fullPage: false });
  });

  test('"My schedule" renders RTL in Arabic for a QA-branch employee, with the overnight marker intact', async ({ page }) => {
    const day = addDays(nextWeek, 2);
    await setCells(request, admin, [{ employeeId: fixtures.qaReportEmployeeId, date: day, shiftDefinitionId: nightId }]);
    await publish(request, admin, day, day);
    await login(page, fixtures.tenantASlug, fixtures.qaReportEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('aside a[href="/schedule"]').click();
    await expect(page.getByTestId('my-schedule-page')).toBeVisible();
    const row = page.getByTestId(`schedule-day-${day}`);
    await expect(row).toHaveAttribute('data-kind', 'SHIFT');
    await expect(row).toHaveAttribute('data-overnight', 'true');
    await expect(row).toContainText('22:00–06:00');
    await page.screenshot({ path: 'test-results/scheduling-my-schedule-rtl.png' });
  });
});
