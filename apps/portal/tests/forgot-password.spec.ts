import { readFileSync } from 'fs';
import { test, expect } from '@playwright/test';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { getPasswordResetToken } from './redis-helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const NEW_PASSWORD = 'NewPassword456!';

test.describe('password show/hide toggle', () => {
  test('login password field is masked by default and toggles to plain text', async ({ page }) => {
    await page.goto('/login');
    const passwordInput = page.locator('#password');
    await passwordInput.fill('some-password');
    await expect(passwordInput).toHaveAttribute('type', 'password');

    const toggle = page.getByRole('button', { name: 'Show password' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();

    await expect(passwordInput).toHaveAttribute('type', 'text');
    const hideToggle = page.getByRole('button', { name: 'Hide password' });
    await expect(hideToggle).toHaveAttribute('aria-pressed', 'true');

    await hideToggle.click();
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });
});

test.describe('forgot / reset password (wired to the existing tenant-scoped endpoints)', () => {
  test('has a link from the login screen', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /forgot password/i }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test('shows the same neutral confirmation whether or not the account exists', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill(fixtures.passwordResetTargetEmail);
    await page.getByRole('button', { name: /send reset code/i }).click();
    await expect(page.getByTestId('forgot-password-confirmation')).toBeVisible();
    const realAccountText = await page.getByTestId('forgot-password-confirmation').innerText();

    await page.goto('/forgot-password');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill('definitely-nobody@portal-e2e-a.test');
    await page.getByRole('button', { name: /send reset code/i }).click();
    await expect(page.getByTestId('forgot-password-confirmation')).toBeVisible();
    const noAccountText = await page.getByTestId('forgot-password-confirmation').innerText();

    expect(realAccountText).toBe(noAccountText);
  });

  test('completes a reset with the dev-logged token, then logs in with the new password', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill(fixtures.passwordResetTargetEmail);
    await page.getByRole('button', { name: /send reset code/i }).click();
    await expect(page.getByTestId('forgot-password-confirmation')).toBeVisible();

    const token = await getPasswordResetToken(fixtures.passwordResetTargetUserId);

    await page.goto('/reset-password');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#token').fill(token);
    await page.locator('#newPassword').fill('short');
    await page.locator('#confirmPassword').fill('short');
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByText(/at least 8 characters/i)).toBeVisible();

    await page.locator('#newPassword').fill(NEW_PASSWORD);
    await page.locator('#confirmPassword').fill('DoesNotMatch1!');
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByText(/do not match/i)).toBeVisible();

    await page.locator('#confirmPassword').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByTestId('reset-password-success')).toBeVisible();

    await page.getByRole('link', { name: /go to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill(fixtures.passwordResetTargetEmail);
    await page.locator('#password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');
  });

  test('an expired/invalid token is rejected with a clear error, never a raw 401', async ({ page }) => {
    await page.goto('/reset-password');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#token').fill('not-a-real-token');
    await page.locator('#newPassword').fill(NEW_PASSWORD);
    await page.locator('#confirmPassword').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByTestId('reset-password-error')).toContainText(/invalid or (has )?expired/i);
  });

  test('existing login flow is unaffected', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill(fixtures.employeeAEmail);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');
  });
});

test.describe('RTL safety of the new auth screens', () => {
  test('forgot-password renders correctly with dir="rtl" forced (logical CSS proof)', async ({ page }) => {
    await page.goto('/forgot-password');
    await expect(page.locator('#email')).toBeVisible();
    // See the identical comment on the toggle-position test below — a
    // one-shot `dir` mutation can race React's hydration commit on the
    // root <html> element, so it's re-applied on every poll iteration.
    await expect
      .poll(() =>
        page.evaluate(() => {
          document.documentElement.dir = 'rtl';
          return document.documentElement.getAttribute('dir');
        }),
      )
      .toBe('rtl');
    const box = await page.locator('#email').boundingBox();
    expect(box).not.toBeNull();
  });

  test('the password show/hide toggle stays inside the input bounds in RTL', async ({ page }) => {
    await page.goto('/login');
    const input = page.locator('#password');
    const toggle = page.getByRole('button', { name: 'Show password' });
    await expect(toggle).toBeVisible();
    // React owns the root <html dir="ltr"> element (RootLayout renders it
    // statically); a plain one-shot `document.documentElement.dir = 'rtl'`
    // can race React's own hydration commit, which reconciles that
    // attribute back to "ltr" if it hasn't finished yet. Re-applying the
    // mutation on every poll iteration guarantees the LAST write — once
    // hydration has genuinely settled — is ours, then confirms the
    // logical-property flip (`insetInlineEnd` resolving to `left: 0`)
    // actually took effect before measuring.
    await expect
      .poll(() =>
        page.evaluate(() => {
          document.documentElement.dir = 'rtl';
          const btn = document.querySelector('button[aria-label="Show password"]');
          return btn ? getComputedStyle(btn).left : null;
        }),
      )
      .toBe('0px');
    const inputBox = await input.boundingBox();
    const toggleBox = await toggle.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    // The toggle sits at the LOGICAL end (`end-0`) which, under RTL, is the
    // LEFT edge of the input — a physical `right-0` class would instead
    // land it back on the right, outside the visually-flipped field.
    expect(toggleBox!.x).toBeLessThan(inputBox!.x + inputBox!.width / 2);
  });
});
