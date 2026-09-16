import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Phase 6.2 accessibility slice — automated WCAG 2.1 A/AA coverage via
 * axe-core over the vendor super-admin console's real, already-rendered
 * screens (no mocks, same posture as every other spec in this directory).
 *
 * axe-core is a STRUCTURAL scanner: it can prove attributes/roles/contrast/
 * names are present and well-formed, but it cannot verify a screen reader
 * actually narrates a sensible flow, that an aria-label is semantically
 * meaningful (only that one exists), or judge cognitive load. Those remain
 * manual-audit-only gaps — see docs/conventions/security-hardening.md for
 * the full list this suite's own findings fed into.
 */
test.describe('Accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('/login — the password-only credentials step', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/login — the MFA challenge step (already-enrolled admin)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(fixtures.enrolledOwnerEmail);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Code')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/dashboard (post-login)', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await expect(page.getByTestId('dashboard-heading')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/tenants — the tenant lifecycle console', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.getByRole('link', { name: 'Tenants' }).click();
    await page.waitForURL('**/tenants');
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/tenants — the "New tenant" modal (focus trap + labeled fields)', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.goto('/tenants');
    await page.getByRole('button', { name: 'New tenant' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
