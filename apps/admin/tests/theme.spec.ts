import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('theme toggle + dashboard charts (vendor console)', () => {
  test('the toggle switches and persists the theme', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    const html = page.locator('html');
    await page.getByTestId('theme-dark').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-light').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('the platform overview renders KPI tiles and charts', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await expect(page.getByTestId('dashboard-heading')).toBeVisible();
    await expect(page.getByTestId('chart-tenants-status').locator('svg.recharts-surface').first()).toBeVisible();
    await page.getByTestId('window-30').click();
    await expect(page.getByTestId('window-30')).toHaveAttribute('aria-checked', 'true');
  });
});
