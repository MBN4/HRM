import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import { generateTotp } from './crypto-helpers';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('mandatory MFA — the real enrollment + login UI', () => {
  test('a fresh admin must complete MFA enrollment before reaching the console', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(fixtures.freshOwnerEmail);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Set up two-factor authentication')).toBeVisible();
    const secret = (await page.getByTestId('mfa-secret').textContent())?.trim();
    expect(secret).toBeTruthy();

    await page.getByLabel(/6-digit code/i).fill(generateTotp(secret!));
    await page.getByRole('button', { name: 'Confirm and finish setup' }).click();

    // Recovery codes are shown exactly once — must acknowledge to proceed.
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    await expect(page.getByTestId('recovery-codes').locator('span')).toHaveCount(10);

    const continueButton = page.getByRole('button', { name: 'Continue to the console' });
    await expect(continueButton).toBeDisabled();
    await page.getByRole('checkbox').check();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await page.waitForURL('**/dashboard');
    await expect(page.getByTestId('dashboard-heading')).toBeVisible();
    // MFA-verified affordance is always visible once signed in.
    await expect(page.getByText('MFA verified')).toBeVisible();
  });

  test('an already-enrolled admin sees the MFA challenge, not the password-only path', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await expect(page.getByTestId('dashboard-heading')).toBeVisible();
  });

  test('rejects a wrong password with a generic error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(fixtures.enrolledOwnerEmail);
    await page.getByLabel('Password').fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('sign out clears the session and further navigation redirects to login', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.getByTestId('sign-out-button').click();
    await page.waitForURL('**/login');
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
  });
});
