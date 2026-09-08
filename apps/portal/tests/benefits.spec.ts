import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Benefits Administration (step 3.5.2) console, end to end against the
 * real API/Postgres/Redis/MinIO stack — see docs/conventions/benefits.md.
 * The payroll-input merge/statutory-divergence/cost-report MATH is already
 * proven at the API level (apps/api/test/benefits.e2e-spec.ts); this suite
 * only needs to prove the UI WIRING — the same "one login per test" /
 * `describe.serial` shape every other console spec in this directory
 * already establishes (see docs/conventions/frontend-admin-console.md).
 */
test.describe.serial('Benefits administration console', () => {
  const simplePlanCode = `wellness-e2e-${Date.now()}`;
  const familyPlanCode = `family-medical-e2e-${Date.now()}`;

  test('admin defines a self-electable FIXED_AMOUNT plan and a tiered plan', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/benefits/admin');

    await page.getByTestId('new-benefit-plan-button').click();
    await page.locator('#plan-code').fill(simplePlanCode);
    await page.locator('#plan-name').fill('Wellness Stipend E2E');
    await page.locator('#plan-currency').fill('USD');
    await page.locator('#plan-fixed-amount').fill('50');
    await page.locator('#plan-employee-share').fill('0.5');
    await page.locator('#plan-employer-share').fill('0.5');
    await page.locator('#plan-self-election').check();
    await page.getByTestId('save-benefit-plan-button').click();
    await expect(page.getByTestId('admin-benefit-plans')).toContainText('Wellness Stipend E2E');

    await page.getByTestId('new-benefit-plan-button').click();
    await page.locator('#plan-code').fill(familyPlanCode);
    await page.locator('#plan-name').fill('Family Medical E2E');
    await page.locator('#plan-currency').fill('USD');
    await page.locator('#plan-has-tiers').check();

    const tierRows = page.getByTestId('benefit-tier-row');
    await tierRows.nth(0).locator('input').nth(0).fill('SOLO');
    await tierRows.nth(0).locator('input').nth(1).fill('Employee only');
    await tierRows.nth(0).locator('input').nth(2).fill('20');
    await tierRows.nth(0).locator('input').nth(3).fill('80');
    await page.getByRole('button', { name: /add tier/i }).click();
    await tierRows.nth(1).locator('input').nth(0).fill('FAMILY');
    await tierRows.nth(1).locator('input').nth(1).fill('Employee + family');
    await tierRows.nth(1).locator('input').nth(2).fill('60');
    await tierRows.nth(1).locator('input').nth(3).fill('140');

    await page.locator('#plan-self-election').check();
    await page.getByTestId('save-benefit-plan-button').click();
    await expect(page.getByTestId('admin-benefit-plans')).toContainText('Family Medical E2E');
  });

  test('managerA adds a dependent via their profile, then elects the FAMILY tier from ESS with that dependent covered', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);

    await page.goto('/profile');
    await page.getByRole('button', { name: /edit profile/i }).click();
    await page.getByRole('button', { name: /add dependent/i }).click();
    await page.getByPlaceholder('Name').last().fill('Junior Manager');
    await page.getByPlaceholder('Relationship').last().fill('CHILD');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Junior Manager')).toBeVisible();

    await page.goto('/benefits');
    await expect(page.getByTestId('available-benefit-plans')).toContainText('Family Medical E2E');
    await page.getByTestId(`elect-plan-${familyPlanCode}`).click();
    await page.locator('#elect-tier').selectOption({ label: 'Employee + family' });
    await page.getByText('Junior Manager').click(); // toggles the dependent checkbox via its <label>
    await page.getByTestId('submit-benefit-election-button').click();

    await expect(page.getByTestId('my-benefit-enrollments')).toContainText('Family Medical E2E');
    await expect(page.getByTestId('my-benefit-enrollments')).toContainText('Active');
  });

  test('a plain employee self-elects a simple FIXED_AMOUNT plan', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/benefits');
    await expect(page.getByTestId('available-benefit-plans')).toContainText('Wellness Stipend E2E');
    await page.getByTestId(`elect-plan-${simplePlanCode}`).click();
    await page.getByTestId('submit-benefit-election-button').click();
    await expect(page.getByTestId('my-benefit-enrollments')).toContainText('Wellness Stipend E2E');
  });

  test('admin sees the statutory schemes for a QA branch, differing from the US branch, through the same panel', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/benefits/admin');

    await page.getByTestId('statutory-branch-select').selectOption(fixtures.branchAQaId);
    await expect(page.getByTestId('statutory-components-list')).toContainText('grsia_pension_employee');

    await page.getByTestId('statutory-branch-select').selectOption(fixtures.branchAUsId);
    await expect(page.getByTestId('statutory-components-list')).toContainText('state_disability_insurance');
  });

  test('a QA-branch employee renders the benefits page right-to-left in Arabic, from the SAME components', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await page.goto('/benefits');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
