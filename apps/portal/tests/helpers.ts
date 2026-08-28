import type { Page } from '@playwright/test';
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
