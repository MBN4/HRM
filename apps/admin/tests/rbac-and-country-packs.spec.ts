import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('least-privilege — PLATFORM_SUPPORT', () => {
  test('the "Platform admins" nav item is hidden, and the actions PLATFORM_SUPPORT cannot take are hidden too', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledSupportEmail, TEST_PASSWORD, fixtures.enrolledSupportTotpSecret);

    // RBAC hides the action, it doesn't just block it — same posture the
    // tenant portal's own admin console takes (2.4).
    await expect(page.getByRole('link', { name: 'Platform admins' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Tenants' }).click();
    await page.waitForURL('**/tenants');
    await expect(page.getByRole('button', { name: 'New tenant' })).toHaveCount(0);

    await page.goto(`/tenants/${fixtures.seededTenantId}`);
    await expect(page.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    // But impersonation IS available — PLATFORM_SUPPORT holds IMPERSONATION_START.
    await expect(page.getByRole('button', { name: 'Impersonate a user' })).toBeVisible();

    await page.getByRole('link', { name: 'Country packs' }).click();
    await page.waitForURL('**/country-packs');
    await expect(page.getByRole('button', { name: 'New country' })).toHaveCount(0);
  });

  test('navigating directly to /admins shows an access-restricted message, not the table', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledSupportEmail, TEST_PASSWORD, fixtures.enrolledSupportTotpSecret);
    await page.goto('/admins');
    await expect(page.getByText(/restricted to PLATFORM_OWNER/)).toBeVisible();
  });
});

test.describe('country pack authoring', () => {
  test('creates a country pack (auto-activates), adds a draft version, edits it, then activates it', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);

    const code = 'ZZ';
    await page.goto('/country-packs');
    await page.getByRole('button', { name: 'New country' }).click();
    await page.getByLabel(/Country code/).fill(code);
    await page.getByRole('button', { name: /Create \(auto-activates/ }).click();

    await expect(page.getByRole('link', { name: code })).toBeVisible();
    await page.getByRole('link', { name: code }).click();
    await page.waitForURL(`**/country-packs/${code}`);
    await expect(page.getByText('Version 1')).toBeVisible();
    await expect(page.getByText('ACTIVE')).toBeVisible();

    await page.getByRole('button', { name: 'New draft version' }).click();
    await expect(page.getByText('Version 2')).toBeVisible();

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText(`Edit ${code} v2 (draft)`)).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(`Edit ${code} v2 (draft)`)).not.toBeVisible();

    await page.getByRole('button', { name: 'Activate' }).click();
    // Version 2's own heading now carries the ACTIVE badge.
    await expect(page.getByRole('heading', { name: /Version 2/ })).toContainText('ACTIVE');
  });
});
