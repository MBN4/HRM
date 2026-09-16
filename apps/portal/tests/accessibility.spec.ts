import { readFileSync } from 'fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Phase 6.2 accessibility slice — automated WCAG 2.1 A/AA coverage via
 * axe-core over the ESS/MSS portal's real, already-rendered screens (no
 * mocks, same posture as every other spec in this directory).
 *
 * RTL gets its OWN scan, not just LTR — a right-to-left layout can
 * introduce issues a left-to-right pass would never surface (mirrored
 * icons losing meaning, focus order, logical-property mistakes) — see
 * rtl.spec.ts for the same LTR/RTL pairing this suite reuses.
 *
 * axe-core is a STRUCTURAL scanner: it can prove attributes/roles/contrast/
 * names are present and well-formed, but it cannot verify a screen reader
 * actually narrates a sensible flow, that an aria-label is semantically
 * meaningful (only that one exists), or judge cognitive load. Those remain
 * manual-audit-only gaps — see docs/conventions/security-hardening.md for
 * the full list this suite's own findings fed into.
 */
test.describe('Accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('/login — unauthenticated', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('ESS dashboard — LTR/English (employeeA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('ESS dashboard — RTL/Arabic (qaEmployeeA, resolved from the QA Country Pack)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/leave — balances + history + the "apply for leave" modal (LTR)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/leave');
    await expect(page.getByTestId('apply-leave-button')).toBeVisible();

    const listResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(listResults.violations).toEqual([]);

    await page.getByTestId('apply-leave-button').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const modalResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(modalResults.violations).toEqual([]);
  });

  test('/leave — RTL/Arabic (qaEmployeeA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await page.goto('/leave');
    await expect(page.getByTestId('apply-leave-button')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('/payroll — the admin-console-shaped Payroll list (adminA)', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/payroll');
    await expect(page.getByRole('heading', { name: /payroll/i })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
