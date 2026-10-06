/**
 * DEV-ONLY — fills the analytics dashboard's PRECOMPUTED rollups for the demo
 * tenant by calling the real `POST /analytics/rollup/run` once per day of the
 * last N days (default 35; the dashboard's 30-day view + its previous-period
 * comparison need ~60, so pass a bigger number for the 90-day range).
 * Needs the API running (the BullMQ processor does the work) and the demo
 * seed applied.  `pnpm --filter @hrm/api run demo:rollup [days]`
 */
const API = process.env.API_URL ?? 'http://localhost:3001';
const SLUG = 'acme-demo';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo.us@acme-demo.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass-123!';
const DAYS = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 65);

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': SLUG },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`Login failed (${login.status}) — did you run seed:demo? ${await login.text()}`);
  const { accessToken } = (await login.json()) as { accessToken: string };

  const today = new Date();
  let ok = 0;
  for (let n = 1; n <= DAYS; n += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n));
    const res = await fetch(`${API}/analytics/rollup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': SLUG, authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ date: d.toISOString().slice(0, 10) }),
    });
    if (res.ok) ok += 1;
    else console.warn(`rollup ${d.toISOString().slice(0, 10)} -> ${res.status} ${await res.text()}`);
  }
  console.log(`Enqueued ${ok}/${DAYS} daily rollups. The worker processes them in a few seconds — then open /analytics.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
