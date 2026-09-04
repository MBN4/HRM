import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const CUSTOM_PRODUCT_NAME = 'Acme Corp HR';

// A 1x1 transparent PNG, small enough to inline.
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test.describe('white-label / branding — the settings UI, cross-tenant isolation, RTL coexistence', () => {
  test('a tenant admin sets product name, color, and a logo — the sidebar reflects it immediately', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/branding');

    await expect(page.getByTestId('branding-product-name-input')).toBeVisible();
    await page.getByTestId('branding-product-name-input').fill(CUSTOM_PRODUCT_NAME);
    await page.getByTestId('branding-primary-color-input').fill('#123456');
    await page.getByTestId('branding-logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG_BUFFER });
    // The logo upload fires its own request immediately (on file select);
    // wait for the settings page to reflect it before saving the rest.
    await expect(page.getByTestId('branding-logo-indicator')).toHaveAttribute('data-uploaded', 'true');

    await page.getByTestId('branding-save-button').click();
    await expect(page.getByText('Branding updated.')).toBeVisible();

    // The sidebar (rendered from the SAME BrandingProvider, no reload) already reflects it.
    await expect(page.getByTestId('branding-product-name')).toHaveText(CUSTOM_PRODUCT_NAME);
  });

  test('reloading the page re-resolves branding from the server and still shows the logo', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.reload();
    await expect(page.getByTestId('branding-product-name')).toHaveText(CUSTOM_PRODUCT_NAME);
    await expect(page.getByTestId('branding-logo')).toBeVisible();
  });

  test('a DIFFERENT tenant never sees tenant A branding — isolation holds', async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await expect(page.getByTestId('branding-product-name')).toHaveText('HRM');
    await expect(page.getByTestId('branding-logo')).toHaveCount(0);
  });

  test('branding renders correctly ALONGSIDE right-to-left — a QA-branch (Arabic/RTL) employee sees BOTH', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    // Same tenant as the admin who set it above — the branded name
    // renders through the SAME component tree the LTR case uses, RTL
    // direction doesn't break the branding read.
    await expect(page.getByTestId('branding-product-name')).toHaveText(CUSTOM_PRODUCT_NAME);
    await expect(page.getByTestId('branding-logo')).toBeVisible();
  });

  test('RBAC: a plain employee cannot reach the branding settings UI', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/branding');
    await expect(page.getByText("You don't have permission to manage branding.")).toBeVisible();
  });

  test('the "Powered by" footer is visible for a non-rebranded tenant', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByTestId('powered-by-footer')).toBeVisible();
  });
});
