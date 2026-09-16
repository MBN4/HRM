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
  // See apps/portal/playwright.config.ts's identical comment — the sibling
  // apps/api jest e2e suite has been observed consuming 70-100%+ CPU
  // against the SAME shared Postgres/Redis concurrently, pushing a real
  // request past 40s under contention. Deliberately NOT `retries: 1` — see
  // that same comment for why a same-state retry isn't safe across this
  // suite's non-idempotent `describe.serial` blocks.
  timeout: 90_000,
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
      // See apps/portal/playwright.config.ts's identical comment — a cold
      // `next build` measured well over 180s under this machine's actual
      // load (concurrent apps/api work). Infra timeout only.
      timeout: 300_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
