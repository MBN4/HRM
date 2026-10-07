import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const KEY = 'mbn.portal.sidebar.v1';

const aside = (page: Page) => page.getByTestId('app-sidebar');
const widthOf = async (page: Page) => Math.round((await aside(page).boundingBox())!.width);
const saved = (page: Page) => page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? 'null'), KEY);

/** Drags the resize handle (centered on the sidebar's inner edge) to an absolute viewport x. */
async function dragHandleTo(page: Page, x: number) {
  const box = (await page.getByTestId('sidebar-resize-handle').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

test.describe('Sidebar (LTR)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(aside(page)).toHaveAttribute('data-ready', 'true');
  });

  test('defaults to expanded; the toggle collapses to an icon rail with tooltips, expands back, and persists across reloads', async ({ page }) => {
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'false');
    await expect.poll(() => widthOf(page)).toBe(264);

    await page.getByTestId('sidebar-toggle').click();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(() => widthOf(page)).toBe(72);
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
    // The label is visually collapsed but stays the link's accessible name.
    await expect(page.getByRole('link', { name: 'Leave', exact: true }).first()).toBeAttached();

    // Hover -> tooltip with the label; leave -> gone.
    await page.locator('aside a[href="/leave"]').hover();
    await expect(page.getByTestId('sidebar-tooltip')).toHaveText(/leave/i);
    await page.mouse.move(600, 400);
    await expect(page.getByTestId('sidebar-tooltip')).toHaveCount(0);
    // Keyboard focus reaches the tooltip too.
    await page.locator('aside a[href="/leave"]').focus();
    await expect(page.getByTestId('sidebar-tooltip')).toBeVisible();

    expect(await saved(page)).toMatchObject({ collapsed: true });
    await page.reload();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(() => widthOf(page)).toBe(72);

    await page.getByTestId('sidebar-toggle').click();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'false');
    await expect.poll(() => widthOf(page)).toBe(264);
    expect(await saved(page)).toMatchObject({ collapsed: false });
  });

  test('drag-resize changes the width within bounds, snaps to the rail below the minimum, and persists', async ({ page }) => {
    await dragHandleTo(page, 320);
    await expect.poll(() => widthOf(page)).toBeGreaterThan(312);
    expect(await widthOf(page)).toBeLessThan(328);
    expect((await saved(page)).width).toBeGreaterThan(312);

    // Max cap.
    await dragHandleTo(page, 700);
    await expect.poll(() => widthOf(page)).toBe(360);

    await page.reload();
    await expect(aside(page)).toHaveAttribute('data-ready', 'true');
    expect(await widthOf(page)).toBe(360);

    // Min clamp (just under the min but above the snap point).
    await dragHandleTo(page, 190);
    await expect.poll(() => widthOf(page)).toBe(224);

    // Far below -> snaps to the collapsed rail.
    await dragHandleTo(page, 100);
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(() => widthOf(page)).toBe(72);
    expect(await saved(page)).toMatchObject({ collapsed: true });

    // Dragging the rail outward re-expands it.
    await dragHandleTo(page, 300);
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'false');
    expect(await widthOf(page)).toBeGreaterThan(290);
  });

  test('the resize handle is keyboard-operable and exposes separator semantics', async ({ page }) => {
    const handle = page.getByTestId('sidebar-resize-handle');
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => widthOf(page)).toBe(280);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => widthOf(page)).toBe(264);
    await page.keyboard.press('Enter');
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
  });

  test('the active nav item follows the current route', async ({ page }) => {
    const dashboard = page.locator('aside a[href="/dashboard"]');
    await expect(dashboard).toHaveAttribute('aria-current', 'page');
    await expect(dashboard).toHaveAttribute('data-active', 'true');
    await page.locator('aside a[href="/leave"]').click();
    await page.waitForURL('**/leave');
    await expect(page.locator('aside a[href="/leave"]')).toHaveAttribute('aria-current', 'page');
    await expect(dashboard).not.toHaveAttribute('aria-current', 'page');
  });

  test('prefers-reduced-motion: no width transition at all', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const duration = await aside(page).evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  });

  test('small screens: an overlay drawer opened from the top bar, not a rail', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(aside(page)).toBeHidden();
    await expect(page.getByTestId('sidebar-resize-handle')).toBeHidden();
    await page.getByTestId('sidebar-mobile-trigger').click();
    await expect(aside(page)).toBeVisible();
    await expect(page.locator('aside a[href="/leave"]')).toBeVisible();
    // Labels are fully shown in the drawer even if the desktop preference is "collapsed".
    await page.getByTestId('sidebar-backdrop').click({ position: { x: 380, y: 400 } });
    await expect(aside(page)).toBeHidden();
    await page.getByTestId('sidebar-mobile-trigger').click();
    await page.locator('aside a[href="/leave"]').click();
    await page.waitForURL('**/leave');
    await expect(aside(page)).toBeHidden(); // closes on navigation
  });

  test('passes axe expanded and collapsed, light and dark', async ({ page }, testInfo) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate((s) => window.localStorage.setItem('mbn.theme', s), scheme);
      await page.reload();
      await expect(aside(page)).toHaveAttribute('data-ready', 'true');
      for (const collapsed of [false, true]) {
        const isCollapsed = (await aside(page).getAttribute('data-collapsed')) === 'true';
        if (isCollapsed !== collapsed) await page.getByTestId('sidebar-toggle').click();
        await expect.poll(() => widthOf(page)).toBe(collapsed ? 72 : 264);
        await aside(page).screenshot({ path: testInfo.outputPath(`sidebar-ltr-${scheme}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
        const results = await new AxeBuilder({ page }).include('aside').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        expect(results.violations).toEqual([]);
      }
    }
  });
});

test.describe('Sidebar (RTL — Qatar branch, Arabic)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(aside(page)).toHaveAttribute('data-ready', 'true');
  });

  test('the sidebar sits on the right, the handle is on its INNER (left) edge, and drag-resize widens it leftward', async ({ page }) => {
    const vw = page.viewportSize()!.width;
    const sb = (await aside(page).boundingBox())!;
    expect(Math.round(sb.x + sb.width)).toBe(vw); // flush with the right edge
    const handle = (await page.getByTestId('sidebar-resize-handle').boundingBox())!;
    expect(Math.abs(handle.x + handle.width / 2 - sb.x)).toBeLessThan(4); // centered on the sidebar's LEFT edge

    await dragHandleTo(page, vw - 340);
    await expect.poll(() => widthOf(page)).toBeGreaterThan(332);
    expect(await widthOf(page)).toBeLessThan(348);
    await dragHandleTo(page, vw - 900);
    await expect.poll(() => widthOf(page)).toBe(360);
    // The inline-start of the rail snaps/clamps the same way as LTR.
    await dragHandleTo(page, vw - 100);
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(() => widthOf(page)).toBe(72);
  });

  test('keyboard: ArrowLeft grows (mirrored), and the rail tooltip opens toward the content (to the LEFT of the icon)', async ({ page }) => {
    const handle = page.getByTestId('sidebar-resize-handle');
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => widthOf(page)).toBe(280);

    await page.getByTestId('sidebar-toggle').click();
    await expect(aside(page)).toHaveAttribute('data-collapsed', 'true');
    const link = page.locator('aside a[href="/leave"]');
    await link.hover();
    const tip = page.getByTestId('sidebar-tooltip');
    await expect(tip).toBeVisible();
    const t = (await tip.boundingBox())!;
    const l = (await link.boundingBox())!;
    expect(t.x + t.width).toBeLessThanOrEqual(l.x + 1);
    expect(await saved(page)).toMatchObject({ collapsed: true });
  });

  test('collapsed + expanded RTL renders and passes axe in light and dark', async ({ page }, testInfo) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate((s) => window.localStorage.setItem('mbn.theme', s), scheme);
      await page.reload();
      await expect(aside(page)).toHaveAttribute('data-ready', 'true');
      for (const collapsed of [false, true]) {
        const isCollapsed = (await aside(page).getAttribute('data-collapsed')) === 'true';
        if (isCollapsed !== collapsed) await page.getByTestId('sidebar-toggle').click();
        await expect.poll(() => widthOf(page)).toBe(collapsed ? 72 : 264);
        await aside(page).screenshot({ path: testInfo.outputPath(`sidebar-rtl-${scheme}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
        const results = await new AxeBuilder({ page }).include('aside').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        expect(results.violations).toEqual([]);
      }
    }
  });
});
