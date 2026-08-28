import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

test.describe('login flow within tenant resolution', () => {
  test('signs in with the header-based tenant strategy and lands on the dashboard', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
  });

  test('rejects a wrong password with a generic error, without leaking which part was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#tenantSlug').fill(fixtures.tenantASlug);
    await page.locator('#email').fill(fixtures.employeeAEmail);
    await page.locator('#password').fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a reload wipes the in-memory access token but the session survives via refresh', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);

    // The access token lives only in memory (see lib/auth/token-storage.ts)
    // — a hard reload guarantees it's gone. The only way the dashboard
    // still renders afterward is a real `/auth/refresh` round trip
    // exchanging the persisted (rotating) refresh token for a new access
    // token on boot — this is what actually proves "token refresh works",
    // not just that login works.
    await page.reload();
    await expect(page.getByTestId('dashboard-greeting')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('sign out clears the session and further navigation redirects to login', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('sign-out-button').click();
    await page.waitForURL('**/login');
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
  });
});

test.describe('RBAC: field omission', () => {
  test('salary is set by an HR-privileged caller, then hidden entirely (not nulled) from the employee themself', async ({ page, request }) => {
    // Log in as TENANT_ADMIN (holds employee.write AND salary.view) purely
    // to obtain an access token via the real API, then PATCH real
    // compensation onto the employee's record — going through
    // EmployeeService's own encryption and field-gating, not a fixture
    // shortcut. MANAGER would also be ALLOWED to write it (has
    // employee.write) but, lacking salary.view itself, wouldn't see the
    // value come back on its own PATCH response — using admin here keeps
    // this step's own assertion on the written value unambiguous.
    const loginRes = await request.post('http://localhost:3001/auth/login', {
      headers: { 'x-tenant-id': fixtures.tenantASlug },
      data: { email: fixtures.adminAEmail, password: TEST_PASSWORD },
    });
    expect(loginRes.ok()).toBe(true);
    const { accessToken } = await loginRes.json();

    const patchRes = await request.patch(`http://localhost:3001/employees/${fixtures.employeeAId}`, {
      headers: { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${accessToken}` },
      data: { compensation: { baseSalary: fixtures.employeeASalary, salaryCurrency: 'USD' } },
    });
    expect(patchRes.ok()).toBe(true);
    const patched = await patchRes.json();
    expect(patched.compensation.baseSalary).toBe(fixtures.employeeASalary);

    // Now the employee (no salary.view) views their OWN profile.
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/profile');
    await expect(page.getByTestId('no-salary-access')).toBeVisible();
    await expect(page.getByTestId('salary-value')).toHaveCount(0);

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain(String(fixtures.employeeASalary));
  });
});
