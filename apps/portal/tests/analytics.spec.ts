import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Proves the analytics dashboard SCREEN — not the rollup computation
 * itself (apps/api/test/analytics.e2e-spec.ts already covers that end to
 * end). Rollup rows are seeded directly into the four precomputed tables
 * by global-setup.ts, dated "yesterday" (the dashboard's own default `to`)
 * so no spec here needs to touch the date filters at all.
 */
test.describe('Analytics dashboard', () => {
  test('an unrestricted manager sees tenant-wide KPIs summed across both branches', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.locator('aside a[href="/analytics"]').click();
    await page.waitForURL('**/analytics');

    // Headcount: 2 (US female) + 1 (US male) + 1 (QA male) = 4.
    await expect(page.getByTestId('kpi-headcount-total')).toHaveText('4');
    // Joiners: 2 (US only). Leavers: 1 (US) + 1 (QA) = 2.
    await expect(page.getByTestId('kpi-joiners')).toHaveText('2');
    await expect(page.getByTestId('kpi-leavers')).toHaveText('2');
    // Attrition rate = leavers / headcount = 2/4 = 50%.
    await expect(page.getByTestId('kpi-attrition')).toHaveText('50%');
    // Attendance rate = present / employeeCount = 5/8 = 62.5%.
    await expect(page.getByTestId('kpi-attendance-rate')).toHaveText('62.5%');
  });

  test('a branch-restricted manager sees only their branch — fewer than the tenant-wide view', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.branchRestrictedManagerEmail);
    await page.goto('/analytics');

    // Only the US branch's 3 employees (2 female + 1 male) — the QA
    // branch's headcount/leaver must not be visible to this caller.
    await expect(page.getByTestId('kpi-headcount-total')).toHaveText('3');
    await expect(page.getByTestId('kpi-leavers')).toHaveText('1');
  });

  test('a plain employee sees no "Analytics" nav entry and gets a graceful notice navigating there directly', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('a[href="/analytics"]')).toHaveCount(0);

    await page.goto('/analytics');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('kpi-headcount-total')).toHaveCount(0);
  });
});
