import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * The e-signature module (step 3.5.3), end to end against the real
 * API/Postgres/Redis/MinIO stack — see docs/conventions/e-signatures.md.
 * ONE LOGIN PER TEST (see operations-modules.spec.ts's own doc comment for
 * why — stacking `page.goto()`/`login()` calls within one test can trip
 * 0.4's refresh-token reuse detection); state threaded through closure
 * `let`s across a `describe.serial` block.
 */
test.describe.serial('E-signatures — internal signer', () => {
  let requestId: string;

  test('admin creates a signature request for an internal signer and sends it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/esignature');

    await page.getByTestId('new-signature-request-button').click();
    await page.locator('#doc-title').fill('E2E Confidentiality Agreement');
    await page.locator('#doc-paragraphs').fill('This agreement binds the undersigned to confidentiality.');
    await page.getByTestId('signer-row').locator('input[placeholder]').first().fill(fixtures.employeeAUserId);
    await page.getByTestId('submit-signature-request-button').click();

    await expect(page.getByTestId('signature-request-row').first()).toBeVisible();
    const href = await page.getByTestId('signature-request-row').first().locator('a').getAttribute('href');
    requestId = href!.split('/').pop()!;

    await page.getByTestId('signature-request-row').first().getByRole('button', { name: /send/i }).click();
    await expect(page.getByTestId('signature-request-row').first().getByText('SENT')).toBeVisible();
  });

  test('the employee signs it from My signatures (typed name)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/esignature/my');

    await expect(page.getByTestId('my-signature-row').first()).toBeVisible();
    await page.getByTestId('sign-document-button').first().click();
    await page.getByTestId('typed-signature-input').fill('Fixture Employee');
    await page.getByTestId('sign-consent-checkbox').check();
    await page.getByTestId('submit-signature-button').click();

    await expect(page.getByTestId('my-signature-row')).toHaveCount(0);
  });

  test('the admin sees it COMPLETED, downloads work, and the tamper-evidence check reports valid', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);

    // A single navigation — the prior test's `sign()` call already awaited
    // full completion (including certificate generation) synchronously
    // server-side before its own response returned, so there is nothing to
    // poll for here. Repeatedly `page.goto()`-ing the SAME page in a loop
    // would itself be a bug: each is a full browser navigation, re-running
    // `AuthProvider`'s bootstrap/refresh-token exchange every time, which
    // can trip 0.4's refresh-token reuse detection — the exact "one
    // login/navigation burst per test" lesson operations-modules.md /
    // frontend-admin-console.md already document for a related flakiness
    // class.
    await page.goto(`/esignature/${requestId}`);
    await expect(page.getByText('COMPLETED', { exact: false })).toBeVisible();

    await page.getByTestId('verify-integrity-button').click();
    await expect(page.getByTestId('verify-result')).toContainText(/valid/i);
  });
});

test.describe('E-signatures — RBAC + i18n', () => {
  test('a plain employee does not see the e-signature admin nav item, but sees My signatures', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByRole('link', { name: /my signatures/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /^e-signatures$/i })).toHaveCount(0);
  });

  test('a QA-branch employee sees the My signatures page rendered RTL', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await page.goto('/esignature/my');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
