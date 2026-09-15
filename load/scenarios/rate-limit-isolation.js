// Phase 5.4 — verifies UNDER REAL LOAD (not just a handful of sequential
// requests, as the existing e2e suite already proves) that a noisy tenant
// exceeding its quota gets 429s while a completely different, quiet
// tenant is unaffected — see docs/conventions/resilience.md § Per-tenant
// rate limiting. Two scenarios in ONE run, both against the SAME server.
import { check } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { authHeaders, BASE_URL, login, TENANTS } from './lib/helpers.js';

const noisy429s = new Counter('noisy_tenant_429s');
const quiet429s = new Counter('quiet_tenant_429s');

// Two DIFFERENT small (PROFESSIONAL, 500 req/60s default quota) tenants —
// picked by NAME, not weighted, so this test is deterministic regardless
// of the manifest's overall size distribution.
const NOISY_TENANT = TENANTS.find((t) => t.slug === 'loadtest-small-1');
const QUIET_TENANT = TENANTS.find((t) => t.slug === 'loadtest-small-2');

export const options = {
  scenarios: {
    noisy_tenant: {
      executor: 'constant-vus',
      vus: 40,
      duration: '30s',
      exec: 'noisy',
    },
    quiet_tenant: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 2,
      exec: 'quiet',
    },
  },
};

// Login ONCE per VU, not per iteration — see dashboard-read.js's own
// comment for why a per-iteration login pattern measures `POST
// /auth/login`'s OWN 5-attempts/15-minute rate limit instead of the
// per-tenant REQUEST quota this scenario actually wants to isolate.
let noisyToken;
let quietToken;

export function noisy() {
  if (!NOISY_TENANT) return;
  if (!noisyToken) {
    noisyToken = login(NOISY_TENANT, NOISY_TENANT.loginEmail);
  }
  if (!noisyToken) return;
  const res = http.get(`${BASE_URL}/resilience/demo/critical`, { headers: authHeaders(NOISY_TENANT, noisyToken) });
  if (res.status === 429) {
    noisy429s.add(1);
  }
}

export function quiet() {
  if (!QUIET_TENANT) return;
  if (!quietToken) {
    quietToken = login(QUIET_TENANT, QUIET_TENANT.loginEmail);
  }
  if (!quietToken) return;
  const res = http.get(`${BASE_URL}/resilience/demo/critical`, { headers: authHeaders(QUIET_TENANT, quietToken) });
  const ok = check(res, { 'quiet tenant: never 429': (r) => r.status !== 429 });
  if (!ok) {
    quiet429s.add(1);
  }
}

export function teardown() {
  // The actual isolation proof is in k6's own end-of-run summary: look for
  // `noisy_tenant_429s` (expected > 0 — the noisy tenant DID get
  // throttled) and `quiet_tenant_429s` (expected 0 — the quiet tenant was
  // never affected) plus the `quiet tenant: never 429` check rate (expected
  // 100%).
  console.log('Check the summary for noisy_tenant_429s (>0 expected) and quiet_tenant_429s (0 expected).');
}
