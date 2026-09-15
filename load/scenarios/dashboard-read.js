// Phase 5.4 — the analytics dashboard read path. Per
// docs/conventions/analytics-dashboard.md this reads ONLY precomputed
// rollup tables, never raw employee/attendance/leave tables — this
// scenario is what actually measures that "always cheap" claim under
// concurrency, across many tenants' managers.
//
// Each VU is assigned ONE tenant (round-robin over `TENANTS`, so both
// whale and small tenants are represented) and logs in ONCE — a real
// manager opens their dashboard repeatedly in one session, they don't
// re-authenticate before every read. An EARLIER version of this script
// called `login()` fresh on every iteration via a RANDOM weighted tenant
// pick, which — combined with the weighting concentrating repeat picks on
// the same couple of manager accounts — burned through `POST /auth/login`'s
// 5-attempts/15-minute per-(tenant,email) rate limit almost immediately,
// making the DASHBOARD look broken when the real cause was this script's
// own login pattern hitting an unrelated, correctly-functioning brute-
// force guard. See docs/conventions/observability-load.md § Load testing
// findings (the same class of mistake `attendance-clockin.js` documents
// its own fix for).
import { check, sleep } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, TENANTS } from './lib/helpers.js';

export const options = {
  scenarios: {
    dashboard_reads: {
      executor: 'constant-vus',
      vus: 30,
      duration: '1m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

let cachedToken;
let cachedTenant;

export default function () {
  if (!cachedToken) {
    cachedTenant = TENANTS[__VU % TENANTS.length];
    cachedToken = login(cachedTenant, cachedTenant.loginEmail);
  }
  if (!cachedToken) {
    return;
  }
  const res = http.get(`${BASE_URL}/analytics/dashboard`, { headers: authHeaders(cachedTenant, cachedToken) });
  check(res, { 'dashboard: 200': (r) => r.status === 200 });
  // A real manager doesn't refresh their dashboard in a tight infinite
  // loop — a THIRD real bug this step's own k6 run caught: with no
  // think-time at all, 30 VUs generate a SUSTAINED request rate no real
  // usage pattern would ever produce, and the resulting near-100% failure
  // rate measured something closer to "how many dashboard reads can this
  // one dev-machine process per second, forever" than "does the dashboard
  // hold up under a realistic number of concurrent managers" — see
  // docs/conventions/observability-load.md § Load testing findings.
  sleep(1);
}
