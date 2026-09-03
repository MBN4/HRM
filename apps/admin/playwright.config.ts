import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser, real-HTTP e2e coverage for the vendor super-admin console
 * (step 4.1) — same "no mocks, hit the real stack" posture
 * apps/portal/playwright.config.ts already established. `PLATFORM_MODE_ENABLED=true`
 * is required for the API webServer here — the whole `@PlatformRoute()`
 * surface this app talks to is rejected otherwise (see
 * docs/conventions/tenant-resolution.md → Platform context).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalSetup: require.resolve('./tests/global-setup.ts'),
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @hrm/api run start',
      url: 'http://localhost:3001/health/live',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PORT: '3001', PLATFORM_MODE_ENABLED: 'true' },
    },
    {
      command: 'pnpm --filter @hrm/admin run build && pnpm --filter @hrm/admin run start',
      url: 'http://localhost:3002',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
