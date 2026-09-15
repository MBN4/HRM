// Phase 5.4 — the HIGH-VOLUME hot path: a real morning clock-in burst
// across many tenants/employees. Each VU logs in ONCE (setup), then
// repeatedly clocks in and immediately out (so the SAME employee can
// clock in again next iteration — a real "already clocked in" 400 would
// otherwise dominate after iteration 1). See
// docs/conventions/attendance.md for why this path is a handful of
// indexed reads/one write, no aggregate computation — this scenario is
// what actually measures that claim under concurrency.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { authHeaders, BASE_URL, login, TENANTS } from './lib/helpers.js';

export const options = {
  scenarios: {
    clockin_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      // Each VU now does exactly ONE clock-in/out pair (see the long
      // `sleep()` at the end of the default function) — ramping to 200
      // models 200 DIFFERENT employees each clocking in once within this
      // burst window, not one employee looping 200 times.
      stages: [
        { duration: '15s', target: 100 },
        { duration: '45s', target: 200 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.98'],
  },
};

// One (tenant, employee) pair per VU, picked ONCE at VU init — models a
// real workforce (each employee clocks themselves in, not a shared account).
export function setup() {
  const assignments = [];
  for (const tenant of TENANTS) {
    for (const email of tenant.employeeLogins) {
      assignments.push({ tenant, email });
    }
  }
  return { assignments };
}

// Module-level `let`s are per-VU (k6 gives each VU its own isolated JS VM,
// so this is NOT shared mutable state across VUs) — caching here is what
// actually makes this "each VU logs in ONCE" as the header comment above
// already claims. An EARLIER version of this script called `login()`
// fresh on every iteration instead, which confounded the very thing this
// scenario is supposed to isolate: repeated argon2id verification (see
// login.js's own measured p95) dominated the numbers, making it look like
// clock-in itself was slow when the login calls were the real cost.
//
// `loginAttempted` (separate from `cachedToken`) is what stops a VU whose
// FIRST login attempt failed from retrying login on every subsequent
// iteration — a REAL bug this step's own k6 run caught: `POST /auth/login`
// is rate-limited at 5 attempts per 15 minutes PER (tenant, email) (see
// auth-rbac.md's own "no user enumeration... rate-limited" note) —
// specifically to slow down brute-force guessing, not to accommodate a
// client retrying every second. A version of this script that retried
// login every iteration on failure burned through that budget in under
// 5 seconds and then stayed 429-locked for the RATE LIMIT'S OWN 15-minute
// window, cascading into what looked like a catastrophic clock-in failure
// rate but was actually this script's own retry storm hitting the auth
// rate limiter, not a clock-in problem at all. See
// docs/conventions/observability-load.md § Load testing findings for the
// full story (including the argon2id CPU-cost angle, which is the real
// reason a first attempt can be slow enough to legitimately fail under
// concurrency in the first place).
let cachedToken;
let cachedTenant;
let cachedHeaders;
let loginAttempted = false;

export default function (data) {
  if (!cachedToken && !loginAttempted) {
    loginAttempted = true;
    const assignment = data.assignments[__VU % data.assignments.length];
    cachedTenant = assignment.tenant;
    cachedToken = login(cachedTenant, assignment.email);
    if (cachedToken) {
      cachedHeaders = authHeaders(cachedTenant, cachedToken);
      delete cachedHeaders['Content-Type']; // multipart — k6 sets its own boundary when body is a plain object
    }
  }
  if (!cachedToken) {
    return; // this VU's one login attempt failed — give up rather than retry into the rate limiter.
  }

  const clockIn = http.post(`${BASE_URL}/attendance/clock-in`, { source: 'WEB' }, { headers: cachedHeaders });
  check(clockIn, { 'clock-in: 201': (r) => r.status === 201 });

  const clockOut = http.post(`${BASE_URL}/attendance/clock-out`, { source: 'WEB' }, { headers: cachedHeaders });
  check(clockOut, { 'clock-out: 201': (r) => r.status === 201 });

  // A real employee clocks in/out ONCE per shift, not in a tight loop —
  // a FOURTH real bug this step's own k6 run caught (the same class as
  // dashboard-read.js's own fix): with no pacing at all, each VU replayed
  // its clock-in/out pair as fast as the server could respond, driving a
  // SUSTAINED request rate this one dev machine's single Node process
  // (limited CPU cores, argon2's own native-threadpool contention, one
  // held-open DB transaction per in-flight request — see
  // tenant-resolution.md's own documented tradeoff) cannot sustain
  // indefinitely — a real, measured ceiling (see
  // docs/conventions/observability-load.md § Load testing findings), but
  // NOT what "everyone clocks in during the 9am burst" actually means:
  // each employee does this exactly once. Sleeping past the scenario's
  // own total duration is what makes that true without a second executor.
  sleep(120);
}
