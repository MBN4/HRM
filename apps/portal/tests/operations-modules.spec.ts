import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * The four operations modules (step 3.1) console, end to end against the
 * real API/Postgres/Redis/MinIO stack — no mocks, matching every other
 * spec in this directory. See docs/conventions/operations-modules.md.
 *
 * ONE LOGIN PER TEST — a lesson already established by
 * docs/conventions/frontend-admin-console.md ("stacking multiple
 * page.goto()/login() calls within one test can race 0.4's refresh-token
 * rotation and trip its reuse-detection guard, redirecting `/login` back
 * to `/dashboard` mid-fill since the earlier session is still valid").
 * Each module gets its own `describe.serial` block — a genuinely stateful
 * lifecycle across several single-login tests, state threaded through via
 * closure `let`s exactly like `payroll.spec.ts`'s own `runId`.
 */
test.describe.serial('Expenses console', () => {
  test('admin creates an expense category via the UI', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/expenses/admin');
    await page.getByRole('button', { name: /new category/i }).click();
    await page.locator('#category-code').fill('TRAVEL-E2E');
    await page.locator('#category-name').fill('Travel');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Travel', { exact: false }).first()).toBeVisible();
  });

  test('employeeA submits a claim from ESS with a line item', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/expenses');

    await page.getByTestId('new-expense-claim-button').click();
    await page.locator('#expense-description').fill('Taxi to client site');
    await page.locator('#expense-amount').fill('42.50');
    await page.locator('#expense-date').fill('2026-01-15');
    await page.getByTestId('add-expense-line-button').click();
    await expect(page.getByTestId('expense-line-row')).toHaveCount(1);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/submit') && res.request().method() === 'POST'),
      page.getByTestId('submit-expense-claim-button').click(),
    ]);

    await expect(page.getByTestId('expense-claim-row').first()).toBeVisible();
    await page.getByTestId('expense-claim-row').first().locator('summary').click();
    await expect(page.getByTestId('workflow-status-panel')).toBeVisible();
  });

  test("managerA approves the claim inline from the Approvals inbox", async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.goto('/approvals');
    const expenseCard = page.locator('[data-testid="approval-card"][data-entity-type="EXPENSE_CLAIM"]');
    await expect(expenseCard).toBeVisible();
    await expenseCard.getByTestId('approve-button').click();
    await expect(expenseCard).toHaveCount(0, { timeout: 10000 });
  });

  test('employeeA sees the claim reach APPROVED', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/expenses');
    await waitFor(async () => {
      await page.reload();
      const text = await page.getByTestId('expense-claim-row').first().innerText();
      return text.includes('Approved') ? true : null;
    });
  });
});

test.describe.serial('Asset Management console', () => {
  test('admin registers an asset category and an asset', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/assets/admin');

    await page.getByRole('button', { name: /new category/i }).click();
    await page.locator('#asset-category-code').fill('LAPTOP-E2E');
    await page.locator('#asset-category-name').fill('Laptops');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Laptops')).toBeVisible();

    await page.getByTestId('register-asset-button').click();
    await page.locator('#asset-tag').fill('LT-E2E-001');
    await page.locator('#asset-name').fill('MacBook Pro E2E');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('MacBook Pro E2E')).toBeVisible();
  });

  test('admin assigns the asset to employeeA', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/assets/admin');

    await page.getByTestId('asset-row').first().locator('summary').click();
    await page.getByTestId('assign-asset-button').click();
    await page.locator('#assign-employee').selectOption({ label: 'Eve Employee' });
    await page.getByTestId('submit-assign-asset-button').click();

    // `onChanged()` reloads the whole asset list — `useAsync`'s
    // `loading: true` window briefly unmounts every `AssetRow` (including
    // this one, mid-`<details open>`), so the row collapses on remount.
    // The SAME "list reload unmounts every row" lesson
    // docs/conventions/frontend-admin-console.md already documents for
    // `MyTasksList` — the fix is procedural, in the TEST: keep re-expanding
    // until the reload has actually landed and the button is there.
    await waitFor(async () => {
      await page.getByTestId('asset-row').first().locator('summary').click();
      return (await page.getByTestId('return-asset-button').isVisible()) ? true : null;
    });
  });

  test('employeeA sees the asset under "My assets"', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/assets');
    await expect(page.getByTestId('my-asset-row').first()).toContainText('MacBook Pro E2E');
  });

  test('admin returns the asset', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/assets/admin');
    await page.getByTestId('asset-row').first().locator('summary').click();
    await page.getByTestId('return-asset-button').click();
    await waitFor(async () => {
      await page.getByTestId('asset-row').first().locator('summary').click();
      return (await page.getByTestId('assign-asset-button').isVisible()) ? true : null;
    });
  });
});

test.describe.serial('HR Helpdesk console', () => {
  test('admin creates a ticket category', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/helpdesk/admin');
    await page.getByRole('button', { name: /new category/i }).click();
    await page.locator('#ticket-category-code').fill('IT-E2E');
    await page.locator('#ticket-category-name').fill('IT Support');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('IT Support')).toBeVisible();
  });

  test('employeeA raises a ticket and comments on it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/helpdesk');
    await page.getByTestId('new-ticket-button').click();
    await page.locator('#ticket-subject').fill('Monitor flickering');
    await page.locator('#ticket-description').fill('My second monitor keeps flickering.');
    await page.getByTestId('submit-new-ticket-button').click();
    await expect(page.getByTestId('ticket-row').first()).toContainText('Monitor flickering');

    await page.getByTestId('ticket-row').first().locator('summary').click();
    await page.getByTestId('ticket-comment-input').fill('Still happening this morning.');
    await page.getByTestId('add-ticket-comment-button').click();
    await expect(page.getByTestId('ticket-comment-row').first()).toContainText('Still happening this morning.');
  });

  test('admin assigns and the ticket moves to IN_PROGRESS', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/helpdesk/admin');
    await page.getByTestId('ticket-row').first().locator('summary').click();
    await page.getByTestId('ticket-assign-select').selectOption({ label: 'Eve Employee' });
    await page.getByTestId('assign-ticket-button').click();
    // Scoped to the row's `<summary>` status badge — a plain `getByText`
    // also matches the (unrelated) `<option value="IN_PROGRESS">` in the
    // status `<select>` further down the same row.
    await expect(page.getByTestId('ticket-row').first().locator('summary').getByText('In progress')).toBeVisible({ timeout: 10000 });
  });
});

test.describe.serial('Announcements & Policies console', () => {
  test('admin publishes an announcement and a policy', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/announcements/admin');

    await page.getByTestId('new-announcement-button').click();
    await page.locator('#announcement-title').fill('Office closure notice');
    await page.locator('#announcement-body').fill('The office will be closed for maintenance.');
    await page.getByRole('button', { name: /publish/i }).click();
    await expect(page.getByTestId('admin-announcement-row').first()).toContainText('Office closure notice');

    await page.getByTestId('new-policy-button').click();
    await page.locator('#policy-title').fill('Remote Work Policy');
    await page.locator('#policy-body').fill('Employees may work remotely up to two days a week.');
    await page.getByRole('button', { name: /publish/i }).click();
    await expect(page.getByTestId('policy-ack-row').first()).toContainText('Remote Work Policy');
  });

  test('employeeA sees both on ESS and acknowledges the policy', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/announcements');
    await expect(page.getByTestId('announcement-row').first()).toContainText('Office closure notice');
    await expect(page.getByTestId('policy-row').first()).toContainText('Remote Work Policy');

    await page.getByTestId('acknowledge-policy-button').click();
    await expect(page.getByText('Acknowledged')).toBeVisible({ timeout: 10000 });
  });

  test('admin sees the acknowledgment tracked', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/announcements/admin');
    await page.getByTestId('policy-ack-row').first().locator('summary').click();
    await expect(page.getByTestId('policy-ack-row').first()).toContainText('1 acknowledged');
  });
});

test.describe('Operations modules RBAC + tenant isolation', () => {
  test('admin sees every operations-module admin nav entry', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await expect(page.locator('a[href="/expenses/admin"]')).toBeVisible();
    await expect(page.locator('a[href="/assets/admin"]')).toBeVisible();
    await expect(page.locator('a[href="/helpdesk/admin"]')).toBeVisible();
    await expect(page.locator('a[href="/announcements/admin"]')).toBeVisible();
  });

  test('a plain EMPLOYEE sees none of the admin nav entries, but keeps the ESS ones', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('a[href="/expenses/admin"]')).toHaveCount(0);
    await expect(page.locator('a[href="/assets/admin"]')).toHaveCount(0);
    await expect(page.locator('a[href="/helpdesk/admin"]')).toHaveCount(0);
    await expect(page.locator('a[href="/announcements/admin"]')).toHaveCount(0);

    await expect(page.locator('a[href="/expenses"]')).toBeVisible();
    await expect(page.locator('a[href="/assets"]')).toBeVisible();
    await expect(page.locator('a[href="/helpdesk"]')).toBeVisible();
  });

  test('an EMPLOYEE in tenant B sees no operations-module data from tenant A — cross-tenant isolation holds structurally', async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await page.goto('/expenses');
    await expect(page.getByTestId('expense-claim-row')).toHaveCount(0);
    await page.goto('/assets');
    await expect(page.getByTestId('my-asset-row')).toHaveCount(0);
    await page.goto('/helpdesk');
    await expect(page.getByTestId('ticket-row')).toHaveCount(0);
    await page.goto('/announcements');
    await expect(page.getByTestId('announcement-row')).toHaveCount(0);
  });
});
