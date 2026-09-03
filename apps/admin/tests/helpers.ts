import type { Page } from '@playwright/test';
import { generateTotp } from './crypto-helpers';

/** Logs in an ALREADY-enrolled admin — password, then a freshly-computed TOTP code. */
export async function loginEnrolled(page: Page, email: string, password: string, totpSecret: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code').fill(generateTotp(totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
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
