import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';
import { addDays, apiHeaders, cleanup, createShift, publish, setCells, weekStartOf, ymdLocal } from './scheduling-helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Phase 6.2 accessibility slice — automated WCAG 2.1 A/AA coverage via
 * axe-core over the ESS/MSS portal's real, already-rendered screens (no
 * mocks, same posture as every other spec in this directory).
 *
 * RTL gets its OWN scan, not just LTR — a right-to-left layout can
 * introduce issues a left-to-right pass would never surface (mirrored
 * icons losing meaning, focus order, logical-property mistakes) — see
 * rtl.spec.ts for the same LTR/RTL pairing this suite reuses.
 *
 * axe-core is a STRUCTURAL scanner: it can prove attributes/roles/contrast/
 * names are present and well-formed, but it cannot verify a screen reader
 * actually narrates a sensible flow, that an aria-label is semantically
 * meaningful (only that one exists), or judge cognitive load. Those remain
 * manual-audit-only gaps — see docs/conventions/security-hardening.md for
 * the full list this suite's own findings fed into.
 */
test.describe('Accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('/login — unauthenticated', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('ESS dashboard — LTR/English (employeeA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('ESS dashboard — RTL/Arabic (qaEmployeeA, resolved from the QA Country Pack)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/leave — balances + history + the "apply for leave" modal (LTR)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/leave');
    await expect(page.getByTestId('apply-leave-button')).toBeVisible();

    const listResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(listResults.violations).toEqual([]);

    await page.getByTestId('apply-leave-button').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const modalResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(modalResults.violations).toEqual([]);
  });

  test('/leave — RTL/Arabic (qaEmployeeA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await page.goto('/leave');
    await expect(page.getByTestId('apply-leave-button')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/payroll — the admin-console-shaped Payroll list (adminA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/payroll');
    await expect(page.getByRole('heading', { name: /payroll/i })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * Step 8.2 — shift scheduling & rostering screens (docs/conventions/shift-scheduling.md). Seeded through the API (a
 * published + a draft cell, incl. an overnight shift) so the scan sees real chips/hatching, not an empty grid; LTR and RTL.
 */
test.describe('Accessibility — shift scheduling (axe-core, WCAG 2.1 A/AA)', () => {
  const nextWeek = addDays(weekStartOf(ymdLocal()), 7);
  const ids: string[] = [];
  let request: import('@playwright/test').APIRequestContext;
  let admin: Record<string, string>;
  const tags = ['wcag2a', 'wcag2aa', 'wcag21aa'];

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    admin = await apiHeaders(request, fixtures, fixtures.adminAEmail);
    const early = await createShift(request, admin, { name: 'A11y Early', startTime: '06:00', endTime: '14:00', color: '#2563eb', minStaffing: 2 });
    const night = await createShift(request, admin, { name: 'A11y Night', startTime: '22:00', endTime: '06:00', color: '#7c3aed' });
    ids.push(early.id, night.id);
    await setCells(request, admin, [
      { employeeId: fixtures.ritaEmployeeId, date: nextWeek, shiftDefinitionId: early.id },
      { employeeId: fixtures.ritaEmployeeId, date: addDays(nextWeek, 1), shiftDefinitionId: night.id },
      { employeeId: fixtures.ritaEmployeeId, date: addDays(nextWeek, 2), dayOff: true },
      { employeeId: fixtures.qaReportEmployeeId, date: addDays(nextWeek, 1), shiftDefinitionId: night.id },
    ]);
    await publish(request, admin, nextWeek, addDays(nextWeek, 1)); // days 0-1 published, day 2 (the day off) stays a draft
  });

  test.afterAll(async () => {
    await cleanup(request, admin, [fixtures.ritaEmployeeId, fixtures.qaReportEmployeeId], nextWeek, addDays(nextWeek, 6), ids);
    await request.dispose();
  });

  async function scan(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations).toEqual([]);
  }

  test('/scheduling roster calendar + the assign dialog — LTR (manager)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.locator('aside a[href="/scheduling"]').click();
    await expect(page.getByTestId('roster-grid')).toBeVisible();
    await page.getByTestId('window-next').click();
    await expect(page.getByTestId('window-title')).toHaveAttribute('data-from', nextWeek);
    await expect(page.getByTestId(`roster-cell-${fixtures.ritaEmployeeId}-${nextWeek}`)).toHaveAttribute('data-kind', 'SHIFT');
    await scan(page);
    await page.getByTestId(`roster-cell-${fixtures.ritaEmployeeId}-${addDays(nextWeek, 3)}`).click();
    await expect(page.getByTestId('assign-modal')).toBeVisible();
    await scan(page);
  });

  test('/scheduling roster calendar (month view) — LTR (manager)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.locator('aside a[href="/scheduling"]').click();
    await page.getByTestId('view-month').click();
    await expect(page.getByTestId('roster-grid')).toBeVisible();
    await scan(page);
  });

  test('/scheduling roster calendar — RTL/Arabic (QA-branch manager)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaManagerEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('aside a[href="/scheduling"]').click();
    await page.getByTestId('window-next').click();
    await expect(page.getByTestId('roster-grid')).toBeVisible();
    await scan(page);
  });

  test('coverage, shifts and standing tabs (admin)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.locator('aside a[href="/scheduling"]').click();
    await page.getByTestId('window-next').click();
    await page.getByTestId('scheduling-tab-coverage').click();
    await expect(page.getByTestId('coverage-table')).toBeVisible();
    await scan(page);
    await page.getByTestId('scheduling-tab-shifts').click();
    await expect(page.getByTestId('shifts-table')).toBeVisible();
    await scan(page);
    await page.getByTestId('shift-add').click();
    await expect(page.getByTestId('shift-form')).toBeVisible();
    await scan(page);
    await page.keyboard.press('Escape');
    await page.getByTestId('scheduling-tab-standing').click();
    await expect(page.getByTestId('standing-teams')).toBeVisible();
    await scan(page);
  });

  test('/schedule (My schedule) + the dashboard card — LTR (employee)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.ritaEmail);
    await expect(page.getByTestId('upcoming-shifts-card')).toBeVisible();
    await scan(page);
    await page.locator('aside a[href="/schedule"]').click();
    await expect(page.getByTestId(`schedule-day-${nextWeek}`)).toHaveAttribute('data-kind', 'SHIFT');
    await scan(page);
  });

  test('/schedule (My schedule) — RTL/Arabic (QA-branch employee)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaReportEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('aside a[href="/schedule"]').click();
    await expect(page.getByTestId('my-schedule-page')).toBeVisible();
    await expect(page.getByTestId(`schedule-day-${addDays(nextWeek, 1)}`)).toHaveAttribute('data-kind', 'SHIFT');
    await scan(page);
  });
});
