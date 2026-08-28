import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('cross-tenant isolation in listed data', () => {
  test('tenant A and tenant B employees see only their own data through the same workspace-slug login flow', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/profile');
    await expect(page.getByText('PE-EMP-1')).toBeVisible();

    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('sign-out-button').click();
    await page.waitForURL('**/login');

    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await page.goto('/profile');
    await expect(page.getByText('PE-B-1')).toBeVisible();
    // Tenant A's employee code must never leak into tenant B's session.
    await expect(page.getByText('PE-EMP-1')).toHaveCount(0);
  });

  test('branch scoping: the org chart hides employees outside the caller\'s allowed branches', async ({ page }) => {
    // managerA is unrestricted — sees both the US and QA reports.
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.goto('/org-chart');
    await expect(page.getByText('Eve Employee')).toBeVisible();
    await expect(page.getByText('Amal Al-Qatari')).toBeVisible();

    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('sign-out-button').click();
    await page.waitForURL('**/login');

    // A manager restricted to the US branch (a real UserBranch row) must
    // not see the QA-branch report, even though both share the same
    // manager — this is enforced by `OrgChartService.build` itself, not
    // application-level filtering the portal adds on top.
    await login(page, fixtures.tenantASlug, fixtures.branchRestrictedManagerEmail);
    await page.goto('/org-chart');
    await expect(page.getByText('Eve Employee')).toBeVisible();
    await expect(page.getByText('Amal Al-Qatari')).toHaveCount(0);
  });
});
