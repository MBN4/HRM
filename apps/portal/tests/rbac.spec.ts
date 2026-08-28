import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('RBAC: a plain employee cannot reach manager-only surfaces', () => {
  test('the EMPLOYEE role sees no "Team" nav entry and gets a graceful notice navigating there directly', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('a[href="/team"]')).toHaveCount(0);

    await page.goto('/team');
    await expect(page.getByRole('alert')).toBeVisible();
    // No approval/report table should render for a caller with neither
    // leave.approve nor attendance.approve.
    await expect(page.locator('table')).toHaveCount(0);
  });

  test('a MANAGER (holds leave.approve/attendance.approve) sees the "Team" nav entry', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await expect(page.locator('a[href="/team"]')).toBeVisible();
  });
});
