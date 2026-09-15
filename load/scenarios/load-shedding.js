// Phase 5.4 — verifies UNDER REAL CONCURRENT LOAD that load shedding
// protects CRITICAL-priority traffic (health checks, login) even while
// LOW-priority traffic is being actively shed — see
// docs/conventions/resilience.md § Load shedding. `/resilience/demo/low-priority`
// is this codebase's own demo/proof route for this (the only route
// marked `@Priority('LOW')` today — everything else defaults to NORMAL,
// which is never shed at this test's load level) — reused here rather
// than invented fresh, the same "prove it against the real mechanism"
// posture the rest of this test suite already takes.
import { check } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, pickWeightedTenant } from './lib/helpers.js';

export const options = {
  scenarios: {
    low_priority_flood: {
      executor: 'constant-vus',
      vus: 150,
      duration: '30s',
      exec: 'lowPriority',
    },
    critical_control: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 5,
      exec: 'critical',
    },
  },
};

// One VU-local login, reused across this VU's own iterations — logging in
// on every single iteration would itself dominate the load, obscuring the
// low-priority flood this scenario is actually about.
let cachedToken;
let cachedTenant;

export function lowPriority() {
  if (!cachedToken) {
    cachedTenant = pickWeightedTenant();
    cachedToken = login(cachedTenant, cachedTenant.loginEmail);
  }
  if (!cachedToken) {
    return;
  }
  // A small artificial delay lets many concurrent LOW requests genuinely
  // overlap in-flight (see LoadSheddingService's own doc comment on why
  // this codebase's demo route supports this) — otherwise a fast burst
  // could resolve before the in-flight counter ever climbs.
  http.get(`${BASE_URL}/resilience/demo/low-priority?ms=200`, { headers: authHeaders(cachedTenant, cachedToken) });
}

export function critical() {
  const res = http.get(`${BASE_URL}/health/live`);
  check(res, { 'CRITICAL /health/live: never shed (never 503)': (r) => r.status === 200 });
}
