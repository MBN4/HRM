import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Multi-legal-entity identity (step 12.1) — the `/legal-entities` admin screen and its tie-ins, end to end in a
 * real browser against the real API/Postgres stack. Runs against the SEEDED demo tenant (`prisma db seed` gives
 * `acme-demo` two legal entities — "Acme Demo Corp, Inc." for the US HQ branch and "Acme Demo Qatar W.L.L." for
 * the Doha branch). Entities it creates carry a per-run stamp and are deleted again at the end.
 */
const TENANT = 'acme-demo';
const PASSWORD = 'DemoPass-123!';
const API = 'http://localhost:3001';
const HR = 'hr@acme-demo.local';
const EMPLOYEE = 'employee@acme-demo.local';
const DOHA_HR = 'demo.qa@acme-demo.local'; // HR role, tied to a Doha employee -> the Qatar pack (Arabic, RTL)
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const STAMP = Date.now().toString(36);
const US_ENTITY = 'Acme Demo Corp, Inc.';
const QA_ENTITY = 'Acme Demo Qatar W.L.L.';

async function headers(request: APIRequestContext, email = HR) {
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

async function loginDemo(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('#tenantSlug').fill(TENANT);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
}

test.describe('legal entities admin', () => {
  test('HR sees the two demo entities with their legal identity, Country-Pack labels and branches', async ({
    page,
  }) => {
    await loginDemo(page, HR);
    await page.getByRole('link', { name: 'Legal entities' }).click();
    await page.waitForURL('**/legal-entities');
    await expect(page.getByRole('heading', { name: 'Legal entities' })).toBeVisible();

    const us = page.getByTestId(`entity-card-${US_ENTITY}`);
    await expect(us).toBeVisible();
    await expect(us).toContainText(/EIN \(Employer Identification Number\):\s*12-3456789/); // label from the US pack
    await expect(us).toContainText('100 Market Street, Suite 400, New York, NY 10005');
    await expect(us).toContainText('Acme US HQ');
    await expect(us.getByText('Default')).toBeVisible();

    const qa = page.getByTestId(`entity-card-${QA_ENTITY}`);
    await expect(qa).toContainText(/Commercial Registration \(CR\) No\.:\s*CR-98765/); // label from the QA pack
    await expect(qa).toContainText('Acme Doha Office');
    // No bank number ever reaches the page.
    await expect(page.locator('body')).not.toContainText(/PK36|IBAN\s*[A-Z]{2}\d{2}/);
  });

  test('create → edit → bank details stay masked → delete, all through the UI', async ({
    page,
    request,
  }) => {
    const name = `E2E Entity ${STAMP}`;
    await loginDemo(page, HR);
    await page.goto('/legal-entities');
    await page.getByTestId('entity-new-button').click();
    await page.getByTestId('entity-legal-name').fill(name);
    await page.getByTestId('entity-country').fill('ae');
    await page.getByTestId('entity-registration').fill(`REG-${STAMP}`);
    await page.getByTestId('entity-tax').fill('TRN-100');
    await page.getByTestId('entity-address1').fill('Sheikh Zayed Road');
    await page.getByTestId('entity-city').fill('Dubai');
    await page.getByTestId('entity-bank-name').fill('Emirates NBD');
    await page.getByTestId('entity-bank-account').fill('AE070331234567890123456');
    await page.getByTestId('entity-save').click();

    const card = page.getByTestId(`entity-card-${name}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(`REG-${STAMP}`);
    await expect(card).toContainText('Sheikh Zayed Road, Dubai');
    await expect(page.locator('body')).not.toContainText('AE070331234567890123456');

    // Edit: the stored account is only hinted at in masked form, never echoed into a field.
    await page.getByTestId(`entity-edit-${name}`).click();
    await expect(page.getByTestId('entity-form')).toContainText('••••3456');
    await expect(page.getByTestId('entity-bank-account')).toHaveValue('');
    await page.getByTestId('entity-city').fill('Abu Dhabi');
    await page.getByTestId('entity-save').click();
    await expect(card).toContainText('Abu Dhabi');

    // Assign a branch: select the (unassigned-to-this) Doha branch → it MOVES here from the QA entity.
    await page.getByTestId(`entity-branches-${name}`).click();
    await page.getByTestId('entity-branch-Acme Doha Office').check();
    await page.getByTestId('entity-branches-save').click();
    await expect(card).toContainText('Acme Doha Office');
    const dohaCardBefore = page.getByTestId(`entity-card-${QA_ENTITY}`);
    await expect(dohaCardBefore).not.toContainText('Acme Doha Office');

    // Employees are derived from the branch.
    await page.getByTestId(`entity-employees-${name}`).click();
    await expect(page.getByTestId('entity-employees-modal')).toBeVisible();
    await page.keyboard.press('Escape');

    // Restore the demo wiring + clean up through the API (a branch must be released before delete).
    const h = await headers(request);
    const list = (await (await request.get(`${API}/legal-entities`, { headers: h })).json()) as {
      id: string;
      legalName: string;
    }[];
    const qaId = list.find((e) => e.legalName === QA_ENTITY)!.id;
    const mineId = list.find((e) => e.legalName === name)!.id;
    const dohaId = (
      (await (await request.get(`${API}/tenancy/branches`, { headers: h })).json()) as {
        id: string;
        name: string;
      }[]
    ).find((b) => b.name === 'Acme Doha Office')!.id;
    expect(
      (
        await request.put(`${API}/legal-entities/${qaId}/branches`, {
          headers: h,
          data: { branchIds: [dohaId] },
        })
      ).ok(),
    ).toBe(true);
    expect((await request.delete(`${API}/legal-entities/${mineId}`, { headers: h })).ok()).toBe(
      true,
    );
  });

  test('statutory reports page can narrow the branch list to one legal entity and shows who the filing is for', async ({
    page,
  }) => {
    await loginDemo(page, HR);
    await page.goto('/statutory-reports');
    // The styled Select renders a combobox button over a hidden native <select>.
    const entitySelect = page.getByRole('combobox', { name: /Legal entity/ });
    await expect(entitySelect).toBeVisible();
    await entitySelect.click();
    await page.getByRole('option', { name: QA_ENTITY }).click();
    await page.getByRole('combobox', { name: /branch/i }).click();
    await expect(page.getByRole('option', { name: /Acme Doha Office/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Acme US HQ/ })).toHaveCount(0);
    await page.getByRole('option', { name: /Acme Doha Office/ }).click();
    await expect(page.getByTestId('statutory-report-filing-for')).toContainText(QA_ENTITY);
    await expect(page.getByTestId('statutory-report-filing-for')).toContainText('CR-98765');
  });

  test('RBAC: an employee has no nav entry and gets the no-access notice (and the API refuses)', async ({
    page,
    request,
  }) => {
    await loginDemo(page, EMPLOYEE);
    await expect(page.getByRole('link', { name: 'Legal entities' })).toHaveCount(0);
    await page.goto('/legal-entities');
    await expect(page.getByText('You do not have access to legal entities.')).toBeVisible();
    const h = await headers(request, EMPLOYEE);
    expect((await request.get(`${API}/legal-entities`, { headers: h })).status()).toBe(403);
  });

  test('renders right-to-left in Arabic (QA-branch HR) without a11y violations, light and dark', async ({
    page,
  }) => {
    await loginDemo(page, DOHA_HR);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.goto('/legal-entities');
    await expect(page.getByRole('heading', { name: 'الكيانات القانونية' })).toBeVisible();
    await expect(page.getByTestId(`entity-card-${QA_ENTITY}`)).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(
        results.violations,
        `${scheme}: ${JSON.stringify(results.violations.map((v) => v.id))}`,
      ).toEqual([]);
    }
    await page.screenshot({ path: 'test-results/legal-entities-rtl.png', fullPage: true });
  });

  test('light mode a11y (LTR) including the create modal', async ({ page }) => {
    await loginDemo(page, HR);
    await page.goto('/legal-entities');
    await expect(page.getByTestId(`entity-card-${US_ENTITY}`)).toBeVisible();
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    await page.getByTestId('entity-new-button').click();
    await expect(page.getByTestId('entity-form')).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
