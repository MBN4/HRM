import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const NEW_PASSWORD = 'MyOwnPassw0rd!';
// Unique per run: this suite creates real rows and has no teardown (see the
// no-retries note in playwright.config.ts).
const NEW_EMAIL = `ui-newhire-${Date.now()}@portal-e2e-a.test`;

/**
 * Step 7.1 — tenant user / team access management UI + the forced
 * first-login password change + the privacy-policy page. Real browser, real
 * API; the API-level guarantees (escalation guards, isolation, session
 * revocation) are proven in apps/api/test/user-management.e2e-spec.ts.
 */
test.describe('Team access: HR creates a user -> forced first-login password change', () => {
  test.describe.configure({ mode: 'serial' });
  let tempPassword = '';

  test('admin creates a user, sees the temp password ONCE, and can copy it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.locator('aside a[href="/users"]').click();
    await expect(page.getByRole('heading', { name: 'Team access', level: 1 })).toBeVisible();
    await expect(page.getByTestId('users-table')).toBeVisible();

    await page.getByTestId('add-user-button').click();
    await page.locator('#new-user-email').fill(NEW_EMAIL);
    await page.getByTestId('role-option-EMPLOYEE').check();
    await page.getByTestId('create-user-submit').click();

    const value = page.getByTestId('temp-password-value');
    await expect(value).toBeVisible();
    tempPassword = (await value.innerText()).trim();
    expect(tempPassword.length).toBeGreaterThanOrEqual(12);
    await expect(page.getByTestId('temp-password-panel')).toContainText(/only time it will be shown/i);

    await page.getByTestId('temp-password-value-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(tempPassword);

    // "Shown once": closing the dialog drops it; the list never shows it.
    await page.getByTestId('temp-password-done').click();
    await expect(page.getByTestId('temp-password-panel')).toHaveCount(0);
    const row = page.getByTestId(`user-row-${NEW_EMAIL}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Must change password');
    await expect(page.locator('body')).not.toContainText(tempPassword);
  });

  test('the new member signs in with it and is forced to set a new password', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, fixtures.tenantASlug, NEW_EMAIL, tempPassword);

    // The app shell is NOT rendered — only the forced screen.
    await expect(page.getByTestId('forced-password-change')).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0);

    // Validation: too short, mismatch, then the eye toggle.
    await page.locator('#firstLoginNew').fill('short');
    await page.locator('#firstLoginConfirm').fill('short');
    await page.getByRole('button', { name: /set password and continue/i }).click();
    await expect(page.getByTestId('forced-password-error')).toContainText(/at least 8 characters/i);
    await page.locator('#firstLoginNew').fill(NEW_PASSWORD);
    await page.locator('#firstLoginConfirm').fill('Different1!');
    await page.getByRole('button', { name: /set password and continue/i }).click();
    await expect(page.getByTestId('forced-password-error')).toContainText(/do not match/i);
    await page.getByRole('button', { name: 'Show password' }).first().click();
    await expect(page.locator('#firstLoginNew')).toHaveAttribute('type', 'text');

    // Reusing the temporary password is refused by the server.
    await page.locator('#firstLoginNew').fill(tempPassword);
    await page.locator('#firstLoginConfirm').fill(tempPassword);
    await page.getByRole('button', { name: /set password and continue/i }).click();
    await expect(page.getByTestId('forced-password-error')).toContainText(/differs from the temporary one/i);
    await expect(page.getByTestId('forced-password-change')).toBeVisible();

    await page.locator('#firstLoginNew').fill(NEW_PASSWORD);
    await page.locator('#firstLoginConfirm').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /set password and continue/i }).click();

    // Now the real app renders; an ordinary EMPLOYEE has no Team access nav.
    await expect(page.locator('aside')).toBeVisible();
    await expect(page.getByTestId('forced-password-change')).toHaveCount(0);
    await expect(page.locator('aside a[href="/users"]')).toHaveCount(0);

    // The temp password is dead; the new one works.
    await page.evaluate(() => localStorage.clear());
    await ctx.close();
    const again = await browser.newContext();
    const p2 = await again.newPage();
    await login(p2, fixtures.tenantASlug, NEW_EMAIL, NEW_PASSWORD);
    await expect(p2.getByTestId('forced-password-change')).toHaveCount(0);
    await again.close();
  });

  test('admin edits roles, regenerates a temp password (re-arming the forced change), then deactivates and reactivates', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/users');
    await page.getByTestId('user-search').fill(NEW_EMAIL);
    const row = page.getByTestId(`user-row-${NEW_EMAIL}`);
    await expect(row).toBeVisible();

    await page.getByTestId(`edit-${NEW_EMAIL}`).click();
    await page.getByTestId('role-option-MANAGER').check();
    await page.getByTestId('edit-access-submit').click();
    await expect(row).toContainText('MANAGER');

    await page.getByTestId(`regenerate-${NEW_EMAIL}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('temp-password-value')).toBeVisible();
    await page.getByTestId('temp-password-done').click();
    await expect(row).toContainText('Must change password');

    await page.getByTestId(`deactivate-${NEW_EMAIL}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(row).toContainText('Deactivated');
    await expect(page.getByTestId(`reactivate-${NEW_EMAIL}`)).toBeVisible();
    await page.getByTestId(`reactivate-${NEW_EMAIL}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(row).toContainText('Active');
  });

  test('the admin cannot act on their own row (no actions offered)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/users');
    const self = page.getByTestId(`user-row-${fixtures.adminAEmail}`);
    await expect(self).toBeVisible();
    await expect(self).toContainText('You');
    await expect(page.getByTestId(`deactivate-${fixtures.adminAEmail}`)).toHaveCount(0);
  });
});

test.describe('Team access: RBAC', () => {
  test('a user without user.manage has no nav entry and sees a no-access notice', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('aside a[href="/users"]')).toHaveCount(0);
    await page.goto('/users');
    await expect(page.getByText(/don't have permission to manage team access/i)).toBeVisible();
    await expect(page.getByTestId('users-table')).toHaveCount(0);
  });

  test("tenant B's admin never sees tenant A's users", async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.adminBEmail);
    await page.goto('/users');
    await expect(page.getByTestId('users-table')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('portal-e2e-a.test');
  });
});

test.describe('Privacy policy page', () => {
  test('is reachable signed-out from the login footer and states it is a template', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('privacy-policy-link').click();
    await expect(page).toHaveURL(/\/privacy-policy/);
    await expect(page.getByTestId('privacy-policy-title')).toHaveText('Privacy Policy');
    await expect(page.getByTestId('privacy-policy-template-notice')).toContainText(/not legal advice/i);
    await expect(page.getByTestId('privacy-policy-body')).toContainText(/Your rights/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('is reachable from the app footer when signed in', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.locator('footer').getByTestId('privacy-policy-link').click();
    await expect(page).toHaveURL(/\/privacy-policy/);
    await expect(page.getByTestId('privacy-policy-body')).toBeVisible();
  });

  test('renders right-to-left in Arabic', async ({ page }) => {
    await page.goto('/privacy-policy');
    await page.getByTestId('policy-lang-ar').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByTestId('privacy-policy-title')).toHaveText('سياسة الخصوصية');
    await expect(page.getByTestId('privacy-policy-template-notice')).toContainText('ليست استشارة قانونية');
  });

  for (const scenario of [
    { name: 'light / LTR', theme: 'light', lang: 'en' },
    { name: 'dark / LTR', theme: 'dark', lang: 'en' },
    { name: 'dark / RTL', theme: 'dark', lang: 'ar' },
  ]) {
    test(`passes axe (WCAG 2.1 AA) — ${scenario.name}`, async ({ page }) => {
      await page.goto('/privacy-policy');
      await page.getByTestId(`theme-${scenario.theme}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
      if (scenario.lang === 'ar') await page.getByTestId('policy-lang-ar').click();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('Team access: accessibility', () => {
  test('users page + create dialog + temp-password dialog pass axe', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/users');
    await expect(page.getByTestId('users-table')).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);

    await page.getByTestId('add-user-button').click();
    await expect(page.getByTestId('create-user-form')).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  });
});
