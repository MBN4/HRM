import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Kiosk mode (step 11.1) — the single-purpose kiosk terminal at `/kiosk` and the `/kiosks` admin screen, end to end
 * in a real browser against the real API/Postgres/Redis stack.
 *
 * Runs against the SEEDED demo tenant (`pnpm --filter @hrm/api run seed:demo`), which provides the documented demo
 * kiosk device token ("US HQ Front Desk") and three employees with fixed kiosk PINs. It never assumes a pristine
 * database: each test that punches leaves the employee clocked OUT again, kiosks it creates carry a per-run stamp and
 * are revoked at the end, and it only ever makes ONE wrong-PIN attempt per employee at a time (5 would lock them).
 *
 * Playwright's own `webServer` reuses a running API/portal, so a stale pre-kiosk API would fail here loudly.
 */
const TENANT = 'acme-demo';
const PASSWORD = 'DemoPass-123!';
const API = 'http://localhost:3001';
const HR = 'hr@acme-demo.local';
const INTERN = 'intern@acme-demo.local';
const DEMO_KIOSK_TOKEN = 'kio_demo_acme_hq_front_desk_token_0001';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const STAMP = Date.now().toString(36);

// Fixed demo PINs (see seed-demo-data.ts).
const INTERN_CODE = 'CHAIN-INTERN';
const INTERN_PIN = '111111';
const LEAD_CODE = 'CHAIN-LEAD';
const LEAD_PIN = '222222';

async function adminHeaders(
  request: APIRequestContext,
  email = HR,
): Promise<Record<string, string>> {
  const res = await request.post(`${API}/auth/login`, {
    headers: { 'x-tenant-id': TENANT },
    data: { email, password: PASSWORD },
  });
  if (!res.ok())
    throw new Error(
      `demo login ${email} failed (${res.status()}) — has the demo tenant been seeded?`,
    );
  return {
    'x-tenant-id': TENANT,
    Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`,
  };
}

async function loginDemo(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#tenantSlug').fill(TENANT);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
}

/** Device-side call (no tenant header, no bearer — only the kiosk token), used to put an employee in a known state. */
async function kioskCall(request: APIRequestContext, token: string, path: string, data: unknown) {
  return request.post(`${API}${path}`, { headers: { 'x-kiosk-token': token }, data });
}
/**
 * Puts an employee in the clocked-OUT state through a SEPARATE helper kiosk (created once per file): the demo kiosk
 * under test enforces a real per-minute identify cap (30/min), which test setup must not consume.
 */
let helperKiosk: { id: string; token: string } | null = null;
async function ensureClockedOut(
  request: APIRequestContext,
  code: string,
  pin: string,
): Promise<void> {
  const token = helperKiosk!.token;
  const id = await kioskCall(request, token, '/kiosk/identify', { employeeCode: code, pin });
  expect(id.status(), `identify ${code}`).toBe(201);
  const body = (await id.json()) as { ticket: string; state: { suggestedAction: string } };
  if (body.state.suggestedAction === 'OUT') {
    const out = await request.post(`${API}/kiosk/clock`, {
      headers: { 'x-kiosk-token': token },
      multipart: { ticket: body.ticket, action: 'OUT' },
    });
    expect(out.status()).toBe(201);
  }
}

async function hqBranchId(
  request: APIRequestContext,
  admin: Record<string, string>,
): Promise<string> {
  const branches = (await (
    await request.get(`${API}/tenancy/branches`, { headers: admin })
  ).json()) as { id: string; name: string }[];
  return branches.find((b) => b.name === 'Acme US HQ')!.id;
}

test.beforeAll(async ({ request }) => {
  const admin = await adminHeaders(request);
  const res = await request.post(`${API}/kiosks`, {
    headers: admin,
    data: { name: `E2E helper ${STAMP}`, branchId: await hqBranchId(request, admin) },
  });
  helperKiosk = (await res.json()) as { id: string; token: string };
});
test.afterAll(async ({ request }) => {
  if (helperKiosk)
    await request.delete(`${API}/kiosks/${helperKiosk.id}`, {
      headers: await adminHeaders(request),
    });
});

async function axeClean(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(
    results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes
        .map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`)
        .slice(0, 4),
    })),
  ).toEqual([]);
}

async function enterCredentials(page: Page, code: string, pin: string): Promise<void> {
  await page.getByTestId('kiosk-code').fill(code);
  // The on-screen keypad is the touch input method — drive it like a finger would.
  for (const digit of pin) await page.getByTestId(`kiosk-key-${digit}`).click();
  await page.getByTestId('kiosk-continue').click();
}

async function openKiosk(page: Page, token = DEMO_KIOSK_TOKEN): Promise<void> {
  await page.goto(`/kiosk#token=${token}`);
  await expect(page.getByTestId('kiosk-idle')).toBeVisible();
}

// Chromium's synthetic camera — a real getUserMedia stream with no hardware (file-level: `use({launchOptions})` forces a worker).
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera'],
});

test.describe('kiosk terminal', () => {
  test.beforeEach(async ({ request }) => {
    await ensureClockedOut(request, INTERN_CODE, INTERN_PIN);
    await ensureClockedOut(request, LEAD_CODE, LEAD_PIN);
  });

  test('pairs from the launch link, strips the token from the URL, and shows nothing but the identify-and-clock flow', async ({
    page,
    context,
  }) => {
    const apiHeaders: Record<string, string>[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(`${API}/kiosk`)) apiHeaders.push(r.headers());
    });

    await openKiosk(page);
    await expect(page.getByTestId('kiosk-name')).toHaveText('US HQ Front Desk');
    await expect(page).toHaveURL(/\/kiosk$/); // the #token fragment is gone from the address bar
    expect(await page.evaluate(() => window.location.hash)).toBe('');

    // Reload: the stored device token re-pairs by itself.
    await page.reload();
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();

    // Locked down: no sidebar/topbar, no navigation links to the rest of the portal.
    expect(await page.locator('aside, nav, [data-testid="sidebar"]').count()).toBe(0);
    expect(await page.locator('main a[href]').count()).toBe(0);

    // The device authenticates with its token ONLY — never a user session.
    expect(apiHeaders.length).toBeGreaterThan(0);
    for (const h of apiHeaders) {
      expect(h['x-kiosk-token']).toBe(DEMO_KIOSK_TOKEN);
      expect(h['authorization']).toBeUndefined();
      expect(h['x-tenant-id']).toBeUndefined();
    }
    void context;
  });

  test('a rejected token shows the setup screen; a good one pairs', async ({ page }) => {
    await page.goto('/kiosk#token=kio_this_is_not_a_real_token');
    await expect(page.getByTestId('kiosk-setup')).toBeVisible();
    await expect(page.getByTestId('kiosk-setup-error')).toBeVisible();
    await page.getByTestId('kiosk-setup-token').fill(DEMO_KIOSK_TOKEN);
    await page.getByTestId('kiosk-setup-submit').click();
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();
  });

  test('a wrong PIN is rejected gracefully and the form is cleared for the next try', async ({
    page,
  }) => {
    await openKiosk(page);
    await enterCredentials(page, LEAD_CODE, '000000');
    const err = page.getByTestId('kiosk-error');
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('data-code', 'KIOSK_INVALID_CREDENTIALS');
    await expect(err).toContainText(/incorrect/i);
    await expect(page.getByTestId('kiosk-pin')).toHaveValue('');
    // …and the right PIN then works (which also clears the failure counter).
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await expect(page.getByTestId('kiosk-identified')).toBeVisible();
  });

  test('clock in, confirmation, auto-reset, then clock out — and the punches are normal KIOSK attendance records', async ({
    page,
    request,
  }) => {
    await openKiosk(page);

    // ---- identify
    await enterCredentials(page, INTERN_CODE, INTERN_PIN);
    await expect(page.getByTestId('kiosk-hello')).toHaveText('Hello, Ivy Intern');
    await expect(page.getByTestId('kiosk-status-line')).toContainText(
      /not clocked in|last clocked out today/i,
    ); // fresh day vs. a repeat run the same day
    await expect(page.getByTestId('kiosk-clock-out')).toBeDisabled();
    await expect(page.getByTestId('kiosk-clock-in')).toBeEnabled();
    await expect(page.getByTestId('kiosk-day-status')).toBeVisible();
    await axeClean(page);

    // ---- clock in
    await page.getByTestId('kiosk-clock-in').click();
    const done = page.getByTestId('kiosk-done');
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('data-action', 'IN');
    await expect(page.getByTestId('kiosk-done-title')).toHaveText('Welcome, Ivy!');
    await axeClean(page);

    // The punch is a standard record, source KIOSK, visible to ordinary attendance reads.
    const admin = await adminHeaders(request);
    const emp = await request.get(`${API}/employees`, {
      headers: admin,
      params: { search: INTERN_CODE },
    });
    const list = ((await emp.json()) as { data: { id: string; employeeCode: string }[] }).data;
    const id = list.find((e) => e.employeeCode === INTERN_CODE)?.id;
    expect(id, 'demo intern employee').toBeTruthy();
    const records = await request.get(`${API}/attendance/records`, {
      headers: admin,
      params: { employeeId: id! },
    });
    const open = ((await records.json()) as { clockInSource: string; status: string }[]).find(
      (r) => r.status === 'OPEN',
    );
    expect(open?.clockInSource).toBe('KIOSK');

    // ---- reset for the next person (explicit tap; the timer does the same after 7s)
    await page.getByTestId('kiosk-done-button').click();
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();
    await expect(page.getByTestId('kiosk-code')).toHaveValue('');
    await expect(page.getByTestId('kiosk-pin')).toHaveValue('');

    // ---- clock out
    await enterCredentials(page, INTERN_CODE, INTERN_PIN);
    await expect(page.getByTestId('kiosk-status-line')).toContainText(/clocked in at/i);
    await expect(page.getByTestId('kiosk-clock-in')).toBeDisabled();
    await page.getByTestId('kiosk-clock-out').click();
    await expect(page.getByTestId('kiosk-done')).toHaveAttribute('data-action', 'OUT');
    await expect(page.getByTestId('kiosk-done-title')).toHaveText('Goodbye, Ivy!');
    await expect(page.getByTestId('kiosk-done')).toContainText(/worked/i);
  });

  test('the confirmation screen returns to idle by itself for the next person', async ({
    page,
  }) => {
    await openKiosk(page);
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await page.getByTestId('kiosk-clock-in').click();
    await expect(page.getByTestId('kiosk-done')).toBeVisible();
    await expect(page.getByTestId('kiosk-idle')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('kiosk-code')).toHaveValue('');
  });

  test('cancel from the confirmation screen returns to idle without punching', async ({
    page,
    request,
  }) => {
    await openKiosk(page);
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await page.getByTestId('kiosk-cancel').click();
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();
    // Still clocked out (beforeEach of the next test would also tolerate either state, but assert it here).
    const id = await kioskCall(request, DEMO_KIOSK_TOKEN, '/kiosk/identify', {
      employeeCode: LEAD_CODE,
      pin: LEAD_PIN,
    });
    expect(
      ((await id.json()) as { state: { suggestedAction: string } }).state.suggestedAction,
    ).toBe('IN');
  });

  test('Arabic switches the whole screen to RTL (the keypad stays LTR), remembers the choice, and is accessible', async ({
    page,
  }) => {
    await openKiosk(page);
    await page.getByTestId('kiosk-lang-ar').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'تسجيل الحضور أو الانصراف' })).toBeVisible();
    await expect(page.getByTestId('kiosk-pad')).toHaveAttribute('dir', 'ltr');
    await axeClean(page);

    // Remembered across a reload (stored per device).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Identified screen in Arabic.
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await expect(page.getByTestId('kiosk-hello')).toContainText('مرحباً');
    await axeClean(page);

    await page.getByTestId('kiosk-lang-en').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('works in dark mode', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('mbn.theme', 'dark'));
    await openKiosk(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await axeClean(page);
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await expect(page.getByTestId('kiosk-identified')).toBeVisible();
    await axeClean(page);
  });

  test('is usable on a tablet viewport (large touch targets, no horizontal scroll)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await openKiosk(page);
    const key = await page.getByTestId('kiosk-key-5').boundingBox();
    expect(key!.width).toBeGreaterThanOrEqual(56);
    expect(key!.height).toBeGreaterThanOrEqual(56);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test('a revoked device shows the deactivated state and can be re-paired', async ({
    page,
    request,
  }) => {
    const admin = await adminHeaders(request);
    const branches = (await (
      await request.get(`${API}/tenancy/branches`, { headers: admin })
    ).json()) as { id: string; name: string }[];
    const hq = branches.find((b) => b.name === 'Acme US HQ')!;
    const created = (await (
      await request.post(`${API}/kiosks`, {
        headers: admin,
        data: { name: `E2E revoke ${STAMP}`, branchId: hq.id },
      })
    ).json()) as { id: string; token: string };

    await openKiosk(page, created.token);
    await request.delete(`${API}/kiosks/${created.id}`, { headers: admin });

    await page.reload();
    await expect(page.getByTestId('kiosk-revoked')).toBeVisible();
    await axeClean(page);
    await page.getByTestId('kiosk-revoked-reset').click();
    await expect(page.getByTestId('kiosk-setup')).toBeVisible();
  });

  test('a device revoked while in use is caught on the next action', async ({ page, request }) => {
    const admin = await adminHeaders(request);
    const branches = (await (
      await request.get(`${API}/tenancy/branches`, { headers: admin })
    ).json()) as { id: string; name: string }[];
    const hq = branches.find((b) => b.name === 'Acme US HQ')!;
    const created = (await (
      await request.post(`${API}/kiosks`, {
        headers: admin,
        data: { name: `E2E live-revoke ${STAMP}`, branchId: hq.id },
      })
    ).json()) as { id: string; token: string };

    await openKiosk(page, created.token);
    await request.delete(`${API}/kiosks/${created.id}`, { headers: admin });
    await enterCredentials(page, LEAD_CODE, LEAD_PIN);
    await expect(page.getByTestId('kiosk-revoked')).toBeVisible();
  });

  test('"Reset device" unpairs after confirmation', async ({ page }) => {
    await openKiosk(page);
    await page.getByTestId('kiosk-unpair').click();
    await page.getByRole('button', { name: 'Reset device' }).last().click();
    await expect(page.getByTestId('kiosk-setup')).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem('mbn.kiosk.token'))).toBeNull();
  });
});

test.describe('kiosk photo capture', () => {
  test('a kiosk that requires a photo captures one with the punch', async ({ page, request }) => {
    const admin = await adminHeaders(request);
    const branches = (await (
      await request.get(`${API}/tenancy/branches`, { headers: admin })
    ).json()) as { id: string; name: string }[];
    const hq = branches.find((b) => b.name === 'Acme US HQ')!;
    const created = (await (
      await request.post(`${API}/kiosks`, {
        headers: admin,
        data: { name: `E2E photo ${STAMP}`, branchId: hq.id, requirePhoto: true },
      })
    ).json()) as { id: string; token: string };

    try {
      await ensureClockedOut(request, LEAD_CODE, LEAD_PIN);
      await openKiosk(page, created.token);
      await enterCredentials(page, LEAD_CODE, LEAD_PIN);
      await expect(page.getByTestId('kiosk-camera')).toBeVisible();
      // The punch button only enables once the camera is live.
      await expect(page.getByTestId('kiosk-clock-in')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('kiosk-clock-in').click();
      await expect(page.getByTestId('kiosk-done')).toBeVisible();

      const activity = (await (
        await request.get(`${API}/kiosks/${created.id}/activity`, { headers: admin })
      ).json()) as { employeeCode: string; hasPhoto: boolean }[];
      expect(activity.find((a) => a.employeeCode === LEAD_CODE)?.hasPhoto).toBe(true);
    } finally {
      await ensureClockedOut(request, LEAD_CODE, LEAD_PIN);
      await request.delete(`${API}/kiosks/${created.id}`, { headers: admin });
    }
  });
});

test.describe('kiosk administration', () => {
  test('HR registers a kiosk, sees its token ONCE, issues a PIN, and that kiosk + PIN clock an employee in', async ({
    page,
    request,
    context,
  }) => {
    const name = `E2E kiosk ${STAMP}`;
    const admin = await adminHeaders(request);
    // An ordinary HQ employee with no PIN yet (never one of the fixed demo ones).
    const branches = (await (
      await request.get(`${API}/tenancy/branches`, { headers: admin })
    ).json()) as { id: string; name: string }[];
    const hq = branches.find((b) => b.name === 'Acme US HQ')!;
    const pins = (await (
      await request.get(`${API}/kiosks/pins`, {
        headers: admin,
        params: { branchId: hq.id, limit: 100 },
      })
    ).json()) as { employeeCode: string; name: string; hasPin: boolean }[];
    const target = pins.find((p) => !p.hasPin && !p.employeeCode.startsWith('CHAIN-'));
    test.skip(!target, 'no PIN-less HQ employee available in the demo data');

    await loginDemo(page, HR);
    await page.goto('/kiosks');
    await expect(page.getByRole('heading', { name: 'Attendance kiosks' })).toBeVisible();
    await expect(page.getByTestId('kiosk-row-US HQ Front Desk')).toBeVisible();

    // ---- register
    await page.getByTestId('kiosk-register-button').click();
    await page.getByTestId('kiosk-register-name').fill(name);
    await page.getByTestId('kiosk-register-branch').selectOption({ label: 'Acme US HQ' });
    await page.getByTestId('kiosk-register-submit').click();
    const tokenValue = page.getByTestId('kiosk-token-value');
    await expect(tokenValue).toBeVisible();
    const token = (await tokenValue.textContent())!.trim();
    expect(token).toMatch(/^kio_[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId('kiosk-launch-link')).toHaveAttribute(
      'href',
      new RegExp(`/kiosk#token=${token}`),
    );
    await page.getByTestId('kiosk-token-done').click();

    // The token is NOT retrievable afterwards.
    await expect(page.getByTestId(`kiosk-row-${name}`)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(token);

    // ---- issue a PIN
    await page.getByTestId('kiosk-tab-pins').click();
    await page.getByTestId('kiosk-pins-search').fill(target!.employeeCode);
    await page.getByTestId(`kiosk-pin-issue-${target!.employeeCode}`).click();
    const pinValue = page.getByTestId('kiosk-pin-value');
    await expect(pinValue).toBeVisible();
    const pin = (await pinValue.textContent())!.trim();
    expect(pin).toMatch(/^\d{6}$/);
    await axeClean(page);
    await page.getByTestId('kiosk-pin-done').click();
    await expect(page.getByTestId(`kiosk-pin-row-${target!.employeeCode}`)).toContainText(/set/i);

    // ---- use them on the kiosk screen
    const kioskPage = await context.newPage();
    await kioskPage.goto(`/kiosk#token=${token}`);
    await expect(kioskPage.getByTestId('kiosk-name')).toHaveText(name);
    await enterCredentials(kioskPage, target!.employeeCode, pin);
    await expect(kioskPage.getByTestId('kiosk-hello')).toContainText(target!.name);
    await kioskPage.getByTestId('kiosk-clock-in').click();
    await expect(kioskPage.getByTestId('kiosk-done')).toHaveAttribute('data-action', 'IN');
    await kioskPage.getByTestId('kiosk-done-button').click();
    await enterCredentials(kioskPage, target!.employeeCode, pin);
    await kioskPage.getByTestId('kiosk-clock-out').click();
    await expect(kioskPage.getByTestId('kiosk-done')).toHaveAttribute('data-action', 'OUT');
    await kioskPage.close();

    // ---- the device's activity + last-seen are visible to admins
    await page.getByTestId('kiosk-tab-devices').click();
    await page.getByTestId(`kiosk-activity-${name}`).click();
    await expect(page.getByTestId('kiosk-activity-table')).toContainText(target!.name);
    await page.keyboard.press('Escape');

    // ---- revoke: the kiosk stops working immediately
    await page.getByTestId(`kiosk-revoke-${name}`).click();
    await page.getByRole('button', { name: 'Revoke' }).last().click();
    await expect(page.getByTestId(`kiosk-row-${name}`)).toContainText(/revoked/i);
    const after = await request.get(`${API}/kiosk/me`, { headers: { 'x-kiosk-token': token } });
    expect(after.status()).toBe(401);

    // Clean up the PIN we issued.
    await request.delete(
      `${API}/kiosks/pins/${((await (await request.get(`${API}/kiosks/pins`, { headers: admin, params: { search: target!.employeeCode } })).json()) as { employeeId: string }[])[0].employeeId}`,
      { headers: admin },
    );
  });

  test('the admin screens are accessible', async ({ page }) => {
    await loginDemo(page, HR);
    await page.goto('/kiosks');
    await expect(page.getByTestId('kiosk-table')).toBeVisible();
    await axeClean(page);
    await page.getByTestId('kiosk-tab-pins').click();
    await expect(page.getByTestId('kiosk-pins-panel')).toBeVisible();
    await axeClean(page);
  });

  test('an employee without kiosk.manage has no Kiosks nav entry and gets the no-access message', async ({
    page,
  }) => {
    await loginDemo(page, INTERN);
    await expect(page.getByRole('link', { name: 'Kiosks' })).toHaveCount(0);
    await page.goto('/kiosks');
    await expect(page.getByText('You do not have access to kiosk management.')).toBeVisible();
  });
});
