// Phase 5.4 — verifies UNDER REAL CONCURRENT LOAD that DB connection-pool
// exhaustion returns a clean 503 with Retry-After, never a hang — see
// docs/conventions/resilience.md § Connection-pool protection. Uses the
// same `/resilience/demo/slow` route `resilience-pool-exhaustion.e2e-spec.ts`
// already proves this against at low concurrency; this scenario is what
// proves it holds under GENUINE concurrent pressure (many more
// simultaneous holders than `DB_POOL_SIZE`, default 10).
import { check } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, pickWeightedTenant } from './lib/helpers.js';

export const options = {
  scenarios: {
    pool_pressure: {
      executor: 'constant-vus',
      vus: 40, // comfortably more than DB_POOL_SIZE (default 10)
      duration: '20s',
    },
  },
  thresholds: {
    // Some 503s are EXPECTED and correct (that's the point) — the real
    // assertion is "no request hangs past REQUEST_TIMEOUT_MS," which
    // http_req_duration's own max already bounds.
    http_req_duration: ['max<31000'], // REQUEST_TIMEOUT_MS default 30000 + margin
  },
};

let cachedToken;
let cachedTenant;

export default function () {
  if (!cachedToken) {
    cachedTenant = pickWeightedTenant();
    cachedToken = login(cachedTenant, cachedTenant.loginEmail);
  }
  if (!cachedToken) {
    return;
  }
  const res = http.get(`${BASE_URL}/resilience/demo/slow?ms=3000`, { headers: authHeaders(cachedTenant, cachedToken) });
  check(res, {
    'either succeeds or fails CLEANLY with 503 (never a raw hang/5xx)': (r) => r.status === 200 || r.status === 503,
    '503 always carries Retry-After': (r) => r.status !== 503 || r.headers['Retry-After'] !== undefined,
  });
}
