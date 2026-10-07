import { readFileSync } from 'fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const API = 'http://localhost:3001';

/**
 * Step 8.1 — Working hours UI. Serial: the precedence test builds Company ->
 * Team -> Member and tears it down again via the UI; afterAll removes any
 * leftovers through the API so reruns/other specs see no policies.
 */
test.describe.configure({ mode: 'serial' });

const memberLabel = `${fixtures.whEmployeeName} (${fixtures.whEmployeeCode})`;

async function openPage(page: Page) {
  await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
  // In-app navigation (a full page.goto re-runs the rate-limited token refresh and flakes).
  await page.locator('aside a[href="/working-hours"]').click();
  await expect(page.getByRole('heading', { name: 'Working hours', level: 1 })).toBeVisible();
  await expect(page.getByTestId('wh-company-form')).toBeVisible();
}

async function fillPolicy(page: Page, prefix: string, v: { start: string; work: string; brk: string; grace: string; half?: string }) {
  await page.getByTestId(`${prefix}-start`).fill(v.start);
  await page.getByTestId(`${prefix}-work`).fill(v.work);
  await page.getByTestId(`${prefix}-break`).fill(v.brk);
  await page.getByTestId(`${prefix}-grace`).fill(v.grace);
  await page.getByTestId(`${prefix}-halfday`).fill(v.half ?? '');
}

async function addOverride(page: Page, addTestId: string, targetValue: string, v: Parameters<typeof fillPolicy>[2]) {
  await page.getByTestId(addTestId).click();
  await expect(page.getByTestId('wh-override-form')).toBeVisible();
  await page.getByTestId('wh-override-target').selectOption({ label: targetValue });
  await fillPolicy(page, 'wh-override', v);
  await page.getByTestId('wh-override-save').click();
  await expect(page.getByTestId('wh-override-form')).toHaveCount(0);
}

async function removeRow(page: Page, rowTestId: string) {
  await page.getByTestId(rowTestId).locator('[data-testid^="wh-remove-"]').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId(rowTestId)).toHaveCount(0);
}

test.afterAll(async ({ playwright }) => {
  const request: APIRequestContext = await playwright.request.newContext();
  const login = await request.post(`${API}/auth/login`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug },
    data: { email: fixtures.adminAEmail, password: TEST_PASSWORD },
  });
  if (!login.ok()) return await request.dispose();
  const headers = { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${(await login.json()).accessToken as string}` };
  const res = await request.get(`${API}/working-hours/policies`, { headers });
  if (!res.ok()) return;
  for (const p of (await res.json()) as { scope: string; target: { id: string } | null }[]) {
    if (p.scope === 'TEAM') await request.delete(`${API}/working-hours/teams/${p.target!.id}`, { headers });
    if (p.scope === 'MEMBER') await request.delete(`${API}/working-hours/members/${p.target!.id}`, { headers });
  }
  await request.dispose();
});

test.describe('Working hours', () => {
  test('sets the company default and shows it saved', async ({ page }) => {
    await openPage(page);
    await fillPolicy(page, 'wh-company', { start: '08:30', work: '8', brk: '1', grace: '10' });
    await expect(page.getByTestId('wh-company-required')).toContainText('8 work + 1 break = 9 h required');
    await page.getByTestId('wh-company-save').click();
    await expect(page.getByTestId('wh-company-saved')).toBeVisible();
    await expect(page.getByTestId('wh-company-error')).toHaveCount(0);
  });

  test('shows inline validation (half-day >= required) and does not save', async ({ page }) => {
    await openPage(page);
    await fillPolicy(page, 'wh-company', { start: '08:30', work: '8', brk: '1', grace: '10', half: '9' });
    await page.getByTestId('wh-company-save').click();
    await expect(page.getByTestId('wh-company-error')).toBeVisible();
    await expect(page.getByText('Half-day threshold must be less than the required hours.')).toBeVisible();
    await expect(page.getByTestId('wh-company-saved')).toHaveCount(0);
  });

  test('precedence: Member -> Team -> Company, via add/remove overrides', async ({ page }) => {
    await openPage(page);

    // Company default first (idempotent upsert).
    await fillPolicy(page, 'wh-company', { start: '08:30', work: '8', brk: '1', grace: '10' });
    await page.getByTestId('wh-company-save').click();
    await expect(page.getByTestId('wh-company-saved')).toBeVisible();

    // Team override (searchable styled select; hidden native select drives the test).
    await addOverride(page, 'wh-add-team', `${fixtures.whDepartmentName} — Portal E2E US HQ`, { start: '10:00', work: '7', brk: '1', grace: '5' });
    await expect(page.getByTestId(`wh-team-row-${fixtures.whDepartmentName}`)).toBeVisible();

    // Member override.
    await addOverride(page, 'wh-add-member', memberLabel, { start: '11:00', work: '6', brk: '0.5', grace: '0' });
    await expect(page.getByTestId(`wh-member-row-${fixtures.whEmployeeCode}`)).toBeVisible();

    // Effective: the member override wins.
    await page.getByTestId('wh-effective-member').selectOption({ label: memberLabel });
    await expect(page.getByTestId('wh-effective-source')).toHaveAttribute('data-source', 'MEMBER');
    await expect(page.getByTestId('wh-effective-start')).toHaveText('11:00');
    await expect(page.getByTestId('wh-effective-required')).toContainText('6.5');
    await expect(page.getByTestId('wh-effective-timezone')).toHaveText('America/New_York');
    await expect(page.getByTestId('wh-precedence')).toHaveAttribute('data-winner', 'MEMBER');

    // Remove the member override -> Team wins.
    await removeRow(page, `wh-member-row-${fixtures.whEmployeeCode}`);
    await expect(page.getByTestId('wh-effective-source')).toHaveAttribute('data-source', 'TEAM');
    await expect(page.getByTestId('wh-effective-start')).toHaveText('10:00');

    // Remove the team override -> Company wins.
    await removeRow(page, `wh-team-row-${fixtures.whDepartmentName}`);
    await expect(page.getByTestId('wh-effective-source')).toHaveAttribute('data-source', 'COMPANY');
    await expect(page.getByTestId('wh-effective-start')).toHaveText('08:30');
    await expect(page.getByTestId('wh-precedence')).toHaveAttribute('data-winner', 'COMPANY');
  });

  test('the override modal shows a validation error and stays open', async ({ page }) => {
    await openPage(page);
    await page.getByTestId('wh-add-member').click();
    await page.getByTestId('wh-override-target').selectOption({ label: memberLabel });
    await fillPolicy(page, 'wh-override', { start: '09:00', work: '8', brk: '1', grace: '5', half: '12' });
    await page.getByTestId('wh-override-save').click();
    await expect(page.getByTestId('wh-override-error')).toBeVisible();
    await expect(page.getByTestId('wh-override-form')).toBeVisible();
  });

  test('passes axe (WCAG 2.1 AA) — light, dark, and with the override modal open', async ({ page }) => {
    await openPage(page);
    const scan = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect((await scan()).violations).toEqual([]);

    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await scan()).violations).toEqual([]);

    await page.getByTestId('wh-add-team').click();
    await expect(page.getByTestId('wh-override-form')).toBeVisible();
    expect((await scan()).violations).toEqual([]);
  });

  test('a plain employee has no nav entry and sees the no-access notice', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('aside a[href="/working-hours"]')).toHaveCount(0);
    // Same direct-URL pattern user-management.spec.ts uses for its RBAC check.
    await page.goto('/working-hours');
    await expect(page.getByText(/don't have permission to manage working hours/i)).toBeVisible();
    await expect(page.getByTestId('wh-company-form')).toHaveCount(0);
  });
});
