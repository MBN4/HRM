import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser, real-HTTP e2e coverage for the ESS/MSS portal — the same
 * "no mocks, hit the real stack" posture every prior step's `*.e2e-spec.ts`
 * takes against the API, extended to the UI layer for the first time. See
 * docs/conventions/frontend-ess-mss.md → "Testing the portal".
 *
 * Runs against `TENANT_HEADER`-based tenant resolution (a plain `localhost`
 * dev setup, no `NEXT_PUBLIC_TENANT_BASE_DOMAIN` configured) so it needs no
 * wildcard-DNS/`/etc/hosts` setup — the same header-based fallback path
 * documented in docs/conventions/tenant-resolution.md for clients with no
 * per-tenant hostname of their own.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalSetup: require.resolve('./tests/global-setup.ts'),
  use: {
    baseURL: 'http://localhost:3003',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @hrm/api run start',
      url: 'http://localhost:3001/health/live',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PORT: '3001' },
    },
    {
      command: 'pnpm --filter @hrm/portal run build && pnpm --filter @hrm/portal run start',
      url: 'http://localhost:3003',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
