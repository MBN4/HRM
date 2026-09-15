// Phase 5.4 — shared helpers for every k6 scenario in this directory. See
// load/README.md for how to run these. Never hardcodes a tenant id/slug/
// password — everything comes from load/fixtures/tenants.json, written by
// `pnpm --filter @hrm/api run seed:load-test`.
import { check } from 'k6';
import http from 'k6/http';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const TENANT_BASE_DOMAIN = __ENV.TENANT_BASE_DOMAIN || 'yourhrms.local';

const manifest = JSON.parse(open('../../fixtures/tenants.json'));
export const TENANTS = manifest.tenants;

export function hostFor(slug) {
  return `${slug}.${TENANT_BASE_DOMAIN}`;
}

/** Picks a tenant, weighted by employeeCount — so a "whale" tenant is proportionally more likely to be picked, modeling real traffic distribution rather than a uniform one. */
export function pickWeightedTenant() {
  const totalWeight = TENANTS.reduce((sum, t) => sum + t.employeeCount, 0);
  let r = Math.random() * totalWeight;
  for (const tenant of TENANTS) {
    r -= tenant.employeeCount;
    if (r <= 0) {
      return tenant;
    }
  }
  return TENANTS[TENANTS.length - 1];
}

export function login(tenant, email, password) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password: password ?? tenant.password }),
    { headers: { 'Content-Type': 'application/json', Host: hostFor(tenant.slug) } },
  );
  check(res, { 'login: 200': (r) => r.status === 200 });
  const body = res.status === 200 ? res.json() : {};
  return body.accessToken;
}

export function authHeaders(tenant, token) {
  return { Authorization: `Bearer ${token}`, Host: hostFor(tenant.slug), 'Content-Type': 'application/json' };
}
