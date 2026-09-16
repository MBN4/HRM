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
  // This machine also runs the sibling apps/api Phase-6.2 work concurrently
  // (its own jest e2e suite has been observed consuming 70-100%+ CPU
  // against the SAME shared Postgres/Redis), which measurably pushed a
  // real login request past 40s under contention — bumped for headroom.
  // Deliberately NOT `retries: 1` — tried and reverted: several specs here
  // (e.g. operations-modules.spec.ts's `describe.serial` Expenses block)
  // create new server-side rows on every run with no per-attempt cleanup,
  // so a retry after a genuine mid-block failure creates a SECOND row
  // alongside the first, breaking a later assertion in a confusing way
  // that has nothing to do with what actually failed. A real timeout is a
  // real signal; masking it with a same-state retry isn't safe here.
  timeout: 90_000,
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
      // A cold `next build` alone measured ~2m50s locally (44 static
      // routes) — 180s was already tight even in isolation, and this
      // machine also runs the sibling apps/api Phase-6.2 work concurrently
      // (competing for CPU), so bumped for headroom. Infra timeout only —
      // no test/assertion weakened.
      timeout: 300_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
