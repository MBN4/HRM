// Phase 5.4 — the auth hot path. Many VUs across MANY tenants (weighted by
// size, see lib/helpers.js), each logging in as either that tenant's
// manager or a random sample employee — never one giant tenant.
import { sleep } from 'k6';
import { login, pickWeightedTenant } from './lib/helpers.js';

export const options = {
  scenarios: {
    login: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    // 1200ms, not the initially-hoped-for 800ms — see
    // docs/conventions/observability-load.md § Load testing findings.
    // Measured p95 at 50 concurrent VUs on this dev machine: ~920ms,
    // 100% success. This is argon2id's OWN deliberate CPU cost (a
    // brute-force defense, not a bug) compounding under concurrency on a
    // single, modest-core dev machine — not a queueing/backpressure
    // problem (0% failures, no 5xx). Login is stateless and CPU-bound, so
    // it scales HORIZONTALLY (more API replicas = more aggregate argon2
    // throughput), not by tuning this number.
    http_req_duration: ['p(95)<1200'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const tenant = pickWeightedTenant();
  const asManager = Math.random() < 0.3;
  const email = asManager
    ? tenant.loginEmail
    : tenant.employeeLogins[Math.floor(Math.random() * tenant.employeeLogins.length)];
  login(tenant, email);
  sleep(1);
}
