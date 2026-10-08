import type { Browser, Page } from '@playwright/test';
import { TEST_PASSWORD } from './fixtures';

export async function login(page: Page, tenantSlug: string, email: string, password = TEST_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('#tenantSlug').fill(tenantSlug);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 15000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Approves a pending workflow step as a DIFFERENT, legitimate approver (step 7.2 hierarchy rules: nobody approves
 * their own request, HR never approves) in a fresh browser context, so the requester's own page/session stays
 * logged in. `open` navigates to the entity and reveals its inline `WorkflowStatusPanel`.
 */
export async function approveAs(
  browser: Browser,
  tenantSlug: string,
  approverEmail: string,
  open: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, tenantSlug, approverEmail);
    await open(page);
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/actions') && res.request().method() === 'POST' && res.ok()),
      page.getByTestId('approve-button').click(),
    ]);
  } finally {
    await context.close();
  }
}
