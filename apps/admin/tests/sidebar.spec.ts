import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURES_PATH, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';
import { TEST_PASSWORD } from './fixtures';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const KEY = 'mbn.admin.sidebar.v1';
const aside = (page: Page) => page.getByTestId('app-sidebar');
const widthOf = async (page: Page) => Math.round((await aside(page).boundingBox())!.width);
const saved = (page: Page) => page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? 'null'), KEY);

async function dragHandleTo(page: Page, x: number) {
  const box = (await page.getByTestId('sidebar-resize-handle').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

test.describe('Vendor console sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await expect(aside(page)).toHaveAttribute('data-ready', 'true');
  });

  test('collapse/expand, tooltip, persistence', async ({ page }) => {
    await expect.poll(() => widthOf(page)).toBe(264);
    await page.getByTestId('sidebar-toggle').click();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(() => widthOf(page)).toBe(72);
    await page.locator('aside a[href="/tenants"]').hover();
    await expect(page.getByTestId('sidebar-tooltip')).toHaveText('Tenants');
    expect(await saved(page)).toMatchObject({ collapsed: true });
    await page.reload();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(() => widthOf(page)).toBe(264);
  });

  test('drag-resize within bounds, persisted; active state follows the route; owner-only item still gated', async ({ page }) => {
    await dragHandleTo(page, 310);
    await expect.poll(() => widthOf(page)).toBeGreaterThan(302);
    await dragHandleTo(page, 800);
    await expect.poll(() => widthOf(page)).toBe(360);
    await page.reload();
    await expect(aside(page)).toHaveAttribute('data-ready', 'true');
    expect(await widthOf(page)).toBe(360);

    await expect(page.locator('aside a[href="/dashboard"]')).toHaveAttribute('aria-current', 'page');
    await page.locator('aside a[href="/tenants"]').click();
    await page.waitForURL('**/tenants');
    await expect(page.locator('aside a[href="/tenants"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('aside a[href="/admins"]')).toBeVisible(); // the PLATFORM_OWNER fixture
  });

  test('passes axe expanded + collapsed in light and dark', async ({ page }, testInfo) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate((s) => window.localStorage.setItem('mbn.theme', s), scheme);
      await page.reload();
      await expect(aside(page)).toHaveAttribute('data-ready', 'true');
      for (const collapsed of [false, true]) {
        const isCollapsed = (await aside(page).getAttribute('data-collapsed')) === 'true';
        if (isCollapsed !== collapsed) await page.getByTestId('sidebar-toggle').click();
        await expect.poll(() => widthOf(page)).toBe(collapsed ? 72 : 264);
        await aside(page).screenshot({ path: testInfo.outputPath(`admin-sidebar-${scheme}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
        const results = await new AxeBuilder({ page }).include('aside').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        expect(results.violations).toEqual([]);
      }
    }
  });

  test('RTL: the admin console mirrors too (handle on the inner edge)', async ({ page }) => {
    await page.evaluate(() => (document.documentElement.dir = 'rtl'));
    const vw = page.viewportSize()!.width;
    const sb = (await aside(page).boundingBox())!;
    expect(Math.round(sb.x + sb.width)).toBe(vw);
    const handle = (await page.getByTestId('sidebar-resize-handle').boundingBox())!;
    expect(Math.abs(handle.x + handle.width / 2 - sb.x)).toBeLessThan(4);
    await dragHandleTo(page, vw - 330);
    await expect.poll(() => widthOf(page)).toBeGreaterThan(322);
  });
});
