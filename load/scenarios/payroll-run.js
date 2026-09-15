// Phase 5.4 — a payroll run (create -> calculate -> poll to COMPUTED),
// against the SAME real HTTP surface a real payroll admin uses. Payroll is
// inherently a rare, heavy operation (see docs/conventions/payroll.md) —
// deliberately LOW concurrency (a handful of VUs, not hundreds), modeling
// "a few admins running month-end payroll around the same time," not a
// user-facing burst. Only ENTERPRISE tenants have MULTI_COUNTRY_PAYROLL
// (see the seed script) — this scenario filters to those.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, TENANTS } from './lib/helpers.js';

const ENTERPRISE_TENANTS = TENANTS.filter((t) => t.edition === 'ENTERPRISE');

export const options = {
  scenarios: {
    payroll_runs: {
      executor: 'constant-vus',
      vus: Math.min(3, ENTERPRISE_TENANTS.length),
      duration: '2m',
    },
  },
  thresholds: {
    checks: ['rate>0.95'],
  },
};

// Once per VU, not per iteration — see dashboard-read.js's own comment
// for why (the login rate limiter, not payroll, is what a per-iteration
// login pattern actually measures).
let cachedToken;
let cachedTenant;

export default function () {
  if (ENTERPRISE_TENANTS.length === 0) {
    return;
  }
  if (!cachedToken) {
    cachedTenant = ENTERPRISE_TENANTS[__VU % ENTERPRISE_TENANTS.length];
    cachedToken = login(cachedTenant, cachedTenant.loginEmail);
  }
  if (!cachedToken) {
    return;
  }
  const tenant = cachedTenant;
  const token = cachedToken;
  const headers = authHeaders(tenant, token);

  // A random, wide period range keeps repeated k6 runs from colliding on
  // an already-used (branch, period) unique combination.
  const periodYear = 2000 + Math.floor(Math.random() * 90);
  const periodMonth = 1 + Math.floor(Math.random() * 12);

  const created = http.post(
    `${BASE_URL}/payroll/runs`,
    JSON.stringify({ branchId: tenant.branchId, periodYear, periodMonth }),
    { headers },
  );
  const okCreate = check(created, { 'payroll run created: 201': (r) => r.status === 201 });
  if (!okCreate) {
    return;
  }
  const runId = created.json().id;

  const calculated = http.post(`${BASE_URL}/payroll/runs/${runId}/calculate`, null, { headers });
  check(calculated, { 'payroll calculate enqueued: 201': (r) => r.status === 201 });

  // Poll until every line has left COMPUTED's precursor state or we give up.
  let allDone = false;
  for (let attempt = 0; attempt < 20 && !allDone; attempt += 1) {
    sleep(1);
    const poll = http.get(`${BASE_URL}/payroll/runs/${runId}`, { headers });
    if (poll.status !== 200) {
      continue;
    }
    const body = poll.json();
    const lines = body.lines || [];
    allDone = lines.length > 0 && lines.every((l) => l.status === 'COMPUTED' || l.status === 'FAILED');
  }
  check({ allDone }, { 'payroll run fully computed within poll window': (r) => r.allDone });
}
