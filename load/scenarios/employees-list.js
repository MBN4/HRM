// Phase 5.4 — a list/search endpoint under concurrency, across many
// tenants — the shape most "browse my org" screens actually hit. Same
// once-per-VU login pattern as dashboard-read.js/attendance-clockin.js —
// see dashboard-read.js's own comment for why (the auth rate limiter, not
// this endpoint, is what a per-iteration login pattern actually measures).
import { check, sleep } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, TENANTS } from './lib/helpers.js';

export const options = {
  scenarios: {
    employees_list: {
      executor: 'constant-vus',
      vus: 30,
      duration: '1m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<400'],
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
  const headers = authHeaders(cachedTenant, cachedToken);
  const list = http.get(`${BASE_URL}/employees?status=ACTIVE`, { headers });
  check(list, { 'employees list: 200': (r) => r.status === 200 });

  const search = http.get(`${BASE_URL}/employees?search=Test1`, { headers });
  check(search, { 'employees search: 200': (r) => r.status === 200 });
  // Real "think time" between page loads — see dashboard-read.js's own
  // comment for why a tight, sleep-free loop measures the wrong thing.
  sleep(1);
}
