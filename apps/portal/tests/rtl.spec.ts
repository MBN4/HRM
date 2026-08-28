import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('RTL: the resolved Country Pack drives direction, not a hardcoded default', () => {
  test('a QA-branch employee renders right-to-left in Arabic', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    // Same component tree as the LTR case below — the sidebar/leave nav
    // link exists regardless of direction, only its rendering flips.
    await expect(page.locator('aside a[href="/leave"]')).toBeVisible();
  });

  test('a US-branch employee renders left-to-right in English, from the SAME components', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('aside a[href="/leave"]')).toBeVisible();
  });
});
