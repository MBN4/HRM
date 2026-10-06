import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const pageBg = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('Theme toggle', () => {
  test('light/dark/system is explicit, persisted, and survives a reload', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    const html = page.locator('html');

    await page.getByTestId('theme-light').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    const lightBg = await pageBg(page);

    await page.getByTestId('theme-dark').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await pageBg(page)).not.toBe(lightBg);
    expect(await page.evaluate(() => localStorage.getItem('mbn.theme'))).toBe('dark');

    // The inline init script applies the stored choice before hydration (checked on the public login screen).
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.goto('/login');
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('"system" removes the explicit attribute and follows the OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.getByTestId('theme-light').click();
    const lightBg = await pageBg(page);
    await page.getByTestId('theme-system').click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await pageBg(page)).not.toBe(lightBg); // OS is dark
    expect(await page.evaluate(() => localStorage.getItem('mbn.theme'))).toBeNull();
  });
});

test.describe('Analytics dashboard — charts + styled dropdown', () => {
  test('renders real charts from the rollup data and the branch dropdown refetches', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.locator('aside a[href="/analytics"]').click();
    await expect(page.getByTestId('kpi-headcount-total')).toHaveText('4');

    for (const id of ['chart-attendance-trend', 'chart-headcount-branch', 'chart-attendance-mix']) {
      await expect(page.getByTestId(id).locator('svg.recharts-surface').first()).toBeVisible();
    }

    // The custom listbox: open, choose a branch via the popover, KPI refetches to that branch only.
    await page.locator('#analytics-branch ~ button').click();
    await expect(page.getByTestId('select-popover')).toBeVisible();
    await page.getByRole('option', { name: /US/ }).first().click();
    await expect(page.getByTestId('select-popover')).toHaveCount(0);
    await expect(page.getByTestId('kpi-headcount-total')).toHaveText('3');

    // Range presets refetch too (the control is a real radiogroup).
    await page.getByTestId('range-7d').click();
    await expect(page.getByTestId('range-7d')).toHaveAttribute('aria-checked', 'true');
  });

  test('theme toggle + styled dropdown work in real RTL (Qatar-branch employee)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('aside a[href="/leave"]').click();
    await page.getByTestId('apply-leave-button').click();
    await page.locator('#leaveType ~ button').click();
    const pop = page.getByTestId('select-popover');
    await expect(pop).toBeVisible(); // portalled, so the Modal's overflow can't clip it
    await expect(pop).toHaveAttribute('dir', 'rtl');
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible(); // Escape closed only the dropdown, not the Modal
  });
});
