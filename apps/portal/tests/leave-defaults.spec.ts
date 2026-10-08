import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Step 8.1 Part 4 — default leave allocation UI (docs/conventions/leave.md § Default leave allocation).
 * Exercises the PK card only (no other spec touches Pakistan's leave), so the persisted tenant override can't
 * perturb the US/QA entitlement assertions elsewhere in this suite.
 */
test.describe.configure({ mode: 'serial' });

async function open(page: Page) {
  await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
  await page.locator('aside a[href="/leave-defaults"]').click();
  await expect(page.getByTestId('leave-defaults-page')).toBeVisible();
  await expect(page.getByTestId('ld-card-PK')).toBeVisible();
}

test('admin sees every leave type with its legal minimum, and an inline below-floor message blocks the save', async ({ page }) => {
  await open(page);
  for (const type of ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY']) {
    await expect(page.getByTestId(`ld-row-PK-${type}`)).toBeVisible();
  }
  const floor = Number(await page.getByTestId('ld-PK-ANNUAL-floor').innerText());
  expect(floor).toBeGreaterThan(0);

  await page.getByTestId('ld-PK-ANNUAL').fill(String(floor - 1));
  await page.getByTestId('ld-save-PK').click();
  const err = page.getByTestId('ld-PK-ANNUAL-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('legal minimum');
  await expect(err).toContainText(String(floor));
  await expect(page.getByTestId('ld-success-PK')).toHaveCount(0);
});

test('a value at/above the floor saves, applies org-wide, and is reflected as the new current default', async ({ page }) => {
  await open(page);
  const floor = Number(await page.getByTestId('ld-PK-SICK-floor').innerText());
  await page.getByTestId('ld-PK-SICK').fill(String(floor + 4));
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/leave/defaults/PK') && r.request().method() === 'PUT' && r.ok()),
    page.getByTestId('ld-save-PK').click(),
  ]);
  await expect(page.getByTestId('ld-success-PK')).toContainText('Saved');
  await expect(page.getByTestId('ld-PK-SICK-current')).toHaveText(String(floor + 4));
  // survives a reload (it is the persisted tenant override, not client state)
  await page.reload();
  await expect(page.getByTestId('ld-PK-SICK-current')).toHaveText(String(floor + 4));
  await expect(page.getByTestId('ld-row-PK-SICK')).toContainText('Customised');
});

test('light + dark pass axe, and the page holds together right-to-left', async ({ page }) => {
  await open(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page }).include('[data-testid="leave-defaults-page"]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
    await page.screenshot({ path: `test-results/leave-defaults-${scheme}.png`, fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dir = 'rtl'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/leave-defaults-rtl.png', fullPage: true });
});

test('a plain employee has no nav entry and sees the no-access notice', async ({ page }) => {
  await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
  await expect(page.locator('aside a[href="/leave-defaults"]')).toHaveCount(0);
  await page.evaluate(() => window.history.pushState({}, '', '/leave-defaults'));
  await page.goto('/leave-defaults');
  await expect(page.getByText("You don't have permission to manage default leave allocation.")).toBeVisible();
});
