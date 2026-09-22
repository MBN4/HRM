import { test, expect } from '@playwright/test';

/**
 * The vendor console has NO self-service forgot/reset-password flow (no
 * backend endpoint exists for `PlatformAdmin` — see
 * docs/conventions/vendor-console.md → "Auth screen polish" for the
 * documented gap), so this suite covers only the password show/hide
 * toggle added to the credentials step. It must never interfere with the
 * mandatory-MFA state machine `auth.spec.ts` already exercises end to end.
 */
test.describe('password show/hide toggle', () => {
  test('the credentials-step password field is masked by default and toggles to plain text', async ({ page }) => {
    await page.goto('/login');
    const passwordInput = page.getByLabel('Password', { exact: true });
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

  test('the toggle stays inside the input bounds in RTL (logical CSS proof)', async ({ page }) => {
    await page.goto('/login');
    const input = page.getByLabel('Password', { exact: true });
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
    expect(toggleBox!.x).toBeLessThan(inputBox!.x + inputBox!.width / 2);
  });
});
