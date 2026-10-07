import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const API = 'http://localhost:3001';

/**
 * Step 7.2 — hierarchical team approvals, portal UI. Seeded chain (global-setup.ts):
 *   h-ceo (CEO) <- h-pm <- h-lead <- h-intern, plus h-peer (also under the CEO).
 * Runs serially because the tests deliberately mutate the chain; every test that
 * changes it restores it (UI or API) so later tests/specs see the seeded shape.
 * The routing/escalation SEMANTICS are proven at the API level
 * (apps/api/test); this suite proves the UI renders and drives them.
 */
test.describe.configure({ mode: 'serial' });

async function token(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug },
    data: { email, password: TEST_PASSWORD },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).accessToken as string;
}

function authHeaders(accessToken: string) {
  return { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${accessToken}` };
}

async function openHierarchy(page: Page) {
  await login(page, fixtures.tenantASlug, fixtures.hierarchyCeoEmail);
  await page.locator('aside a[href="/hierarchy"]').click();
  await expect(page.getByRole('heading', { name: 'Reporting hierarchy', level: 1 })).toBeVisible();
  await expect(page.getByTestId('hierarchy-tree')).toBeVisible();
}

const node = (page: Page, email: string) => page.getByTestId(`hierarchy-node-${email}`);

async function reassign(page: Page, email: string, managerUserId: string) {
  await page.getByTestId(`hierarchy-change-manager-${email}`).click();
  await expect(page.getByTestId('change-manager-form')).toBeVisible();
  await page.getByTestId('manager-select').selectOption(managerUserId);
  await page.getByTestId('manager-save').click();
}

test.describe('Reporting hierarchy page', () => {
  test('renders the seeded chain as a collapsible tree with roles and approver lines', async ({ page }) => {
    await openHierarchy(page);

    for (const email of [fixtures.hierarchyCeoEmail, fixtures.hierarchyPmEmail, fixtures.hierarchyLeadEmail, fixtures.hierarchyInternEmail]) {
      await expect(node(page, email)).toBeVisible();
    }
    await expect(page.getByTestId(`hierarchy-role-${fixtures.hierarchyCeoEmail}`)).toHaveAttribute('data-role', 'CEO');
    await expect(page.getByTestId(`hierarchy-role-${fixtures.hierarchyPmEmail}`)).toHaveAttribute('data-role', 'MANAGER');
    await expect(page.getByTestId(`hierarchy-role-${fixtures.hierarchyInternEmail}`)).toHaveAttribute('data-role', 'MEMBER');

    // "Approvals go to" = the direct manager.
    const internLine = page.getByTestId(`hierarchy-approver-${fixtures.hierarchyInternEmail}`);
    await expect(internLine).toContainText(fixtures.hierarchyLeadEmail);
    await expect(internLine).toHaveAttribute('data-routing-kind', 'DIRECT_MANAGER');
    await expect(page.getByTestId(`hierarchy-reports-${fixtures.hierarchyLeadEmail}`)).toContainText('1');
    await expect(page.getByTestId('hierarchy-legend')).toBeVisible();

    // Collapse / expand one branch.
    const pmToggle = page.getByTestId(`hierarchy-toggle-${fixtures.hierarchyPmEmail}`);
    await expect(pmToggle).toHaveAttribute('aria-expanded', 'true');
    await pmToggle.click();
    await expect(pmToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(node(page, fixtures.hierarchyLeadEmail)).toHaveCount(0);
    await expect(node(page, fixtures.hierarchyInternEmail)).toHaveCount(0);
    await pmToggle.click();
    await expect(node(page, fixtures.hierarchyInternEmail)).toBeVisible();

    // Collapse all / expand all.
    await page.getByTestId('hierarchy-collapse-all').click();
    await expect(node(page, fixtures.hierarchyPmEmail)).toHaveCount(0);
    await expect(node(page, fixtures.hierarchyCeoEmail)).toBeVisible();

    // Search force-opens the ancestors of a hit so it is never hidden, and highlights it.
    await page.getByTestId('hierarchy-search').fill(fixtures.hierarchyInternEmail);
    await expect(node(page, fixtures.hierarchyInternEmail)).toBeVisible();
    await expect(node(page, fixtures.hierarchyInternEmail)).toHaveAttribute('data-match', 'true');
    await expect(page.getByTestId('hierarchy-match-count')).toContainText('1');
    await page.getByTestId('hierarchy-search').fill('');

    await page.getByTestId('hierarchy-expand-all').click();
    await expect(node(page, fixtures.hierarchyInternEmail)).toBeVisible();
  });

  test('reassigning a manager via ManagerSelect updates the tree and the "Approvals go to" line; a loop shows the server error', async ({ page, request }) => {
    await openHierarchy(page);
    const internLine = page.getByTestId(`hierarchy-approver-${fixtures.hierarchyInternEmail}`);

    // intern: lead -> pm
    await reassign(page, fixtures.hierarchyInternEmail, fixtures.hierarchyPmUserId);
    await expect(page.getByTestId('change-manager-form')).toHaveCount(0);
    await expect(internLine).toContainText(fixtures.hierarchyPmEmail);
    await expect(internLine).not.toContainText(fixtures.hierarchyLeadEmail);
    await expect(page.getByTestId(`hierarchy-reports-${fixtures.hierarchyLeadEmail}`)).toContainText('0');

    // ...and back: pm -> lead (restores the seeded chain).
    await reassign(page, fixtures.hierarchyInternEmail, fixtures.hierarchyLeadUserId);
    await expect(internLine).toContainText(fixtures.hierarchyLeadEmail);

    // The picker itself blocks loops client-side: a person's own descendants (and themself) are not offered.
    await page.getByTestId(`hierarchy-change-manager-${fixtures.hierarchyPmEmail}`).click();
    const options = page.getByTestId('manager-select').locator('option');
    await expect(options.filter({ hasText: fixtures.hierarchyLeadEmail })).toHaveCount(0);
    await expect(options.filter({ hasText: fixtures.hierarchyInternEmail })).toHaveCount(0);
    await expect(options.filter({ hasText: fixtures.hierarchyPmEmail })).toHaveCount(0);
    await expect(options.filter({ hasText: fixtures.hierarchyCeoEmail })).toHaveCount(1);
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Server-side validation: make the page's view STALE so the UI offers a choice that is now a loop.
    // Server truth: peer -> under intern. Page still thinks peer is under the CEO.
    const ceoToken = await token(request, fixtures.hierarchyCeoEmail);
    try {
      const move = await request.patch(`${API}/users/${fixtures.hierarchyPeerUserId}/manager`, {
        headers: authHeaders(ceoToken),
        data: { managerId: fixtures.hierarchyInternUserId },
      });
      expect(move.ok()).toBe(true);

      // lead -> peer would now close the loop lead -> peer -> intern -> lead.
      await reassign(page, fixtures.hierarchyLeadEmail, fixtures.hierarchyPeerUserId);
      await expect(page.getByTestId('manager-error')).toBeVisible();
      await expect(page.getByTestId('manager-error')).not.toBeEmpty();
      await expect(page.getByTestId('change-manager-form')).toBeVisible(); // stays open
      await page.getByRole('button', { name: 'Cancel' }).click();
    } finally {
      await request.patch(`${API}/users/${fixtures.hierarchyPeerUserId}/manager`, {
        headers: authHeaders(ceoToken),
        data: { managerId: fixtures.hierarchyCeoUserId },
      });
    }
  });

  test('passes axe (WCAG 2.1 AA) — light, dark, and with the change-manager dialog open', async ({ page }) => {
    await openHierarchy(page);
    const scan = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect((await scan()).violations).toEqual([]);

    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await scan()).violations).toEqual([]);

    await page.getByTestId(`hierarchy-change-manager-${fixtures.hierarchyInternEmail}`).click();
    await expect(page.getByTestId('change-manager-form')).toBeVisible();
    expect((await scan()).violations).toEqual([]);
  });
});

test.describe('Team access: Reports to', () => {
  test('the Users page shows the manager column and the change-manager action reassigns', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.hierarchyCeoEmail);
    await page.goto('/users');
    await page.getByTestId('user-search').fill('h-lead@');
    const row = page.getByTestId(`user-row-${fixtures.hierarchyLeadEmail}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`user-manager-${fixtures.hierarchyLeadEmail}`)).toContainText(fixtures.hierarchyPmEmail);
    // Raw role name stays visible; the plain-language label sits beneath it.
    await expect(row).toContainText('MANAGER');
    await expect(page.getByTestId(`user-role-label-${fixtures.hierarchyLeadEmail}`)).toHaveText('Manager');

    await page.getByTestId(`manager-${fixtures.hierarchyLeadEmail}`).click();
    await page.getByTestId('manager-select').selectOption(fixtures.hierarchyCeoUserId);
    await page.getByTestId('manager-save').click();
    await expect(page.getByTestId('change-manager-form')).toHaveCount(0);
    await expect(page.getByTestId(`user-manager-${fixtures.hierarchyLeadEmail}`)).toContainText(fixtures.hierarchyCeoEmail);

    // Restore: lead -> pm.
    await page.getByTestId(`manager-${fixtures.hierarchyLeadEmail}`).click();
    await page.getByTestId('manager-select').selectOption(fixtures.hierarchyPmUserId);
    await page.getByTestId('manager-save').click();
    await expect(page.getByTestId(`user-manager-${fixtures.hierarchyLeadEmail}`)).toContainText(fixtures.hierarchyPmEmail);
  });

  test('a user without user.manage has no Reporting hierarchy nav entry', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('aside a[href="/hierarchy"]')).toHaveCount(0);
    await page.goto('/hierarchy');
    await expect(page.getByText(/don't have permission to manage team access/i)).toBeVisible();
  });
});

test.describe('Approvals inbox: why it is in my queue', () => {
  async function submitRequestAs(request: APIRequestContext, email: string): Promise<string> {
    const entityId = randomUUID();
    const res = await request.post(`${API}/workflow/instances`, {
      headers: authHeaders(await token(request, email)),
      data: { entityType: 'EXPENSE_CLAIM', entityId, dataSnapshot: { amount: 25, currencyCode: 'USD' } },
    });
    expect(res.ok()).toBe(true);
    return entityId;
  }

  test('a direct report\'s request shows the "Direct report" reason to their manager; the CEO sees it under Org-wide', async ({ page, request, browser }) => {
    await submitRequestAs(request, fixtures.hierarchyInternEmail);

    await login(page, fixtures.tenantASlug, fixtures.hierarchyLeadEmail);
    await page.goto('/approvals');
    const reason = page.getByTestId('approval-reason').first();
    await expect(reason).toBeVisible();
    await expect(reason).toHaveAttribute('data-reason', 'DIRECT_MANAGER');
    await expect(reason).toContainText('Direct report');
    await expect(reason).toContainText('reports to you');

    // The CEO is not the addressee, so the same request lands in the separate Org-wide section.
    const ceoCtx = await browser.newContext();
    const ceoPage = await ceoCtx.newPage();
    await login(ceoPage, fixtures.tenantASlug, fixtures.hierarchyCeoEmail);
    await ceoPage.goto('/approvals');
    const orgSection = ceoPage.getByTestId('approvals-section-org');
    await expect(orgSection).toBeVisible();
    await expect(orgSection.getByTestId('approval-reason').first()).toHaveAttribute('data-reason', 'CEO_OVERRIDE');
    await expect(orgSection).toContainText('Org-wide (CEO)');
    await ceoCtx.close();
  });

  test('when the manager is deactivated the request escalates: tree shows the warning, the next manager sees the "Escalated" reason', async ({ page, request, browser }) => {
    const ceoToken = await token(request, fixtures.hierarchyCeoEmail);
    const off = await request.post(`${API}/users/${fixtures.hierarchyLeadUserId}/deactivate`, { headers: authHeaders(ceoToken) });
    expect(off.ok()).toBe(true);
    try {
      await submitRequestAs(request, fixtures.hierarchyInternEmail);

      await openHierarchy(page);
      const line = page.getByTestId(`hierarchy-approver-${fixtures.hierarchyInternEmail}`);
      await expect(line).toHaveAttribute('data-routing-kind', 'ESCALATED_MANAGER_UNAVAILABLE');
      await expect(line).toContainText(fixtures.hierarchyPmEmail);
      await expect(line).toContainText(/escalated/i);
      await expect(node(page, fixtures.hierarchyLeadEmail)).toContainText('Deactivated');

      const pmCtx = await browser.newContext();
      const pmPage = await pmCtx.newPage();
      await login(pmPage, fixtures.tenantASlug, fixtures.hierarchyPmEmail);
      await pmPage.goto('/approvals');
      await expect(pmPage.locator('[data-testid="approval-reason"][data-reason="ESCALATED_MANAGER_UNAVAILABLE"]').first()).toBeVisible();
      await pmCtx.close();
    } finally {
      await request.post(`${API}/users/${fixtures.hierarchyLeadUserId}/reactivate`, { headers: authHeaders(ceoToken) });
    }
  });
});
