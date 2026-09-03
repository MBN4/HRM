import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('tenant lifecycle', () => {
  test('creates a tenant, suspends it (blocked), resumes it, edits it, then deletes it', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);

    await page.getByRole('link', { name: 'Tenants' }).click();
    await page.waitForURL('**/tenants');

    const slug = `admin-e2e-ui-${Date.now()}`;
    const name = `UI Created Co ${Date.now()}`;
    await page.getByRole('button', { name: 'New tenant' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Slug').fill(slug);
    await page.getByLabel('Default country code').fill('US');
    await page.getByLabel('Hosting region').fill('us-east-1');
    await page.getByRole('button', { name: 'Create tenant' }).click();

    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await page.getByRole('link', { name, exact: true }).click();
    await page.waitForURL(/\/tenants\/.+/);

    await expect(page.getByText('TRIAL')).toBeVisible();

    await page.getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByText(/tenant is SUSPENDED/i)).toBeVisible();

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText(/tenant is SUSPENDED/i)).not.toBeVisible();

    // Edit edition
    await page.getByLabel('Edition', { exact: true }).selectOption('ENTERPRISE');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // Delete — type-to-confirm gate.
    await page.getByRole('button', { name: 'Delete' }).click();
    const deleteButton = page.getByRole('button', { name: 'Permanently delete' });
    await expect(deleteButton).toBeDisabled();
    await page.getByLabel(new RegExp(`Type ${slug} to confirm`)).fill(slug);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    await page.waitForURL('**/tenants');
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  });

  test('impersonates a tenant user and the session is visible in the impersonation history', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);

    await page.goto(`/tenants/${fixtures.seededTenantId}`);
    await page.getByRole('button', { name: 'Impersonate a user' }).click();
    await page.getByLabel('Target user').selectOption(fixtures.seededTenantUserId);
    await page.getByLabel(/Reason/).fill('verifying the impersonation UI end to end');
    await page.getByRole('button', { name: 'Start impersonation' }).click();

    await expect(page.getByText(/You are now impersonating this user/)).toBeVisible();
    await expect(page.getByLabel('Access token')).toHaveValue(/.+/);
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('link', { name: 'Impersonation' }).click();
    await page.waitForURL('**/impersonation');
    await expect(page.getByText('verifying the impersonation UI end to end')).toBeVisible();
    await expect(page.getByText('Active').first()).toBeVisible();

    await page.getByRole('button', { name: 'End' }).first().click();
    await expect(page.getByText('Ended').first()).toBeVisible();
  });

  test("the impersonation session and the follow-on action are visible in that tenant's own audit trail", async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);

    await page.getByRole('link', { name: 'Audit trail' }).click();
    await page.waitForURL('**/audit');
    await page.getByLabel('Tenant id', { exact: true }).fill(fixtures.seededTenantId);
    await page.getByRole('button', { name: 'Read' }).click();

    await expect(page.getByText('platform.impersonation.started').first()).toBeVisible();
  });
});
