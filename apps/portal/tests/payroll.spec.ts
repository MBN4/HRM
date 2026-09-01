import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const API = 'http://localhost:3001';

// A far-future period that no other spec/run could plausibly collide with —
// `PayrollRun` has a partial unique index on (tenantId, branchId,
// periodYear, periodMonth) for REGULAR runs, so re-running this suite
// against the same seeded tenant must never reuse a period another test
// (or a prior local run) already created.
const PERIOD_YEAR = 2099;
const PERIOD_MONTH = 1;

/**
 * Polls the run detail page's own in-app "Refresh" button (a lightweight
 * client-side re-fetch via `useAsync`'s `reload()`) rather than
 * `page.reload()` — a FULL browser navigation is both much slower (re-runs
 * the whole client bootstrap: session, employee, country pack, THEN the
 * run itself) and risks canceling an in-flight request if it lands mid-poll.
 * Used for state that changes asynchronously server-side (the `PayrollRun`
 * status flip on `workflow.approved` is a fire-and-forget event listener,
 * not part of the HTTP response) — matching the "no auto-polling, click
 * Refresh" posture the run detail page itself takes.
 */
async function refreshUntil(page: Page, check: () => Promise<boolean>): Promise<void> {
  await waitFor(
    async () => {
      await page.getByTestId('refresh-button').click();
      return (await check()) ? true : null;
    },
    20000,
    500,
  );
}

/**
 * The Payroll console, end to end against the real API/Postgres/Redis/
 * BullMQ stack — no mocks, matching every other spec in this directory.
 * One `describe.serial` block: run creation -> calculate -> approve ->
 * finalize -> mark-paid -> payslip/bank-export download is inherently a
 * single stateful lifecycle, so later tests depend on the run id created
 * by the first. RBAC/cross-tenant checks are independent and live in
 * their own trailing tests.
 */
test.describe.serial('Payroll console', () => {
  let runId: string;

  test('admin gives employeeA a real base salary, then creates a payroll run via the UI', async ({ page, request }) => {
    // Real HTTP, not a fixture shortcut — the run must compute a non-zero
    // gross/net for a meaningful field-omission + totals proof below.
    const loginRes = await request.post(`${API}/auth/login`, {
      headers: { 'x-tenant-id': fixtures.tenantASlug },
      data: { email: fixtures.adminAEmail, password: TEST_PASSWORD },
    });
    const { accessToken } = await loginRes.json();
    const patchRes = await request.patch(`${API}/employees/${fixtures.employeeAId}`, {
      headers: { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${accessToken}` },
      data: { compensation: { baseSalary: 6000, salaryCurrency: 'USD' } },
    });
    expect(patchRes.ok()).toBe(true);

    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/payroll');
    await expect(page.getByTestId('new-run-button')).toBeVisible();
    await page.getByTestId('new-run-button').click();

    await page.locator('#run-branch').selectOption(fixtures.branchAUsId);
    await page.locator('#run-year').fill(String(PERIOD_YEAR));
    await page.locator('#run-month').fill(String(PERIOD_MONTH));
    await page.getByTestId('submit-new-run-button').click();

    await page.waitForURL('**/payroll/*');
    const url = new URL(page.url());
    runId = url.pathname.split('/').pop()!;
    expect(runId).toBeTruthy();

    await expect(page.getByTestId('run-status-badge')).toContainText('Draft');
  });

  test('Calculate drives the real BullMQ engine to CALCULATED with computed line rows', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/calculate') && res.request().method() === 'POST'),
      page.getByTestId('calculate-run-button').click(),
    ]);
    await expect(page.getByText('Calculating payroll')).toBeVisible();

    await refreshUntil(page, async () => (await page.getByTestId('run-status-badge').innerText()).includes('Calculated'));

    await expect(page.getByTestId('payroll-line-row').first()).toBeVisible();
    const rowCount = await page.getByTestId('payroll-line-row').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('the admin (holds salary.view) sees gross/net totals on the run', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    await expect(page.getByTestId('run-total-gross')).toBeVisible();
    await expect(page.getByTestId('run-total-net')).toBeVisible();
    const grossText = await page.getByTestId('run-total-gross').innerText();
    expect(grossText).not.toBe('');
  });

  test('a caller holding payroll.run but NOT salary.view sees amounts entirely absent from the DOM', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.payrollNoSalaryEmail);
    await page.goto(`/payroll/${runId}`);

    await expect(page.getByTestId('run-totals')).toHaveCount(0);
    await expect(page.getByTestId('run-total-gross')).toHaveCount(0);
    await expect(page.getByTestId('run-total-net')).toHaveCount(0);
    await expect(page.getByTestId('line-gross-pay')).toHaveCount(0);
    await expect(page.getByTestId('line-net-pay')).toHaveCount(0);
    await expect(page.getByText("don't have permission to view salary amounts")).toBeVisible();
  });

  test('submit for approval surfaces the WorkflowStatusPanel, and approving it reaches APPROVED', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    // Wait for the actual POST to complete — `submitPayrollRunForApproval`
    // creates the `WorkflowInstance` synchronously within this same
    // request, so the page's own post-success `reload()` already picks up
    // `workflowInstanceId` and mounts the panel with no further polling
    // needed.
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/submit-for-approval') && res.request().method() === 'POST'),
      page.getByTestId('submit-run-button').click(),
    ]);

    await expect(page.getByTestId('workflow-status-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('workflow-step-row')).toHaveCount(1);

    // The seeded PayrollRun workflow template uses a `ROLE: TENANT_ADMIN`
    // approver rule (see global-setup.ts) — the SAME admin who submitted
    // the run is eligible to approve it, so no re-login is needed.
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/actions') && res.request().method() === 'POST'),
      page.getByTestId('approve-button').click(),
    ]);

    // The `PayrollRun.status` flip to APPROVED happens via a fire-and-forget
    // `workflow.approved` event listener (see docs/conventions/payroll.md)
    // — genuinely async and separate from the panel's own instance/step
    // state, so THIS specific check needs the Refresh-button poll.
    await refreshUntil(page, async () => (await page.getByTestId('run-status-badge').innerText()).includes('Approved'));
  });

  test('Finalize then Mark paid transition the run through its terminal statuses', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/finalize') && res.request().method() === 'POST'),
      page.getByTestId('finalize-run-button').click(),
    ]);
    await expect(page.getByTestId('run-status-badge')).toContainText('Finalized', { timeout: 10000 });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/mark-paid') && res.request().method() === 'POST'),
      page.getByTestId('mark-paid-button').click(),
    ]);
    await expect(page.getByTestId('run-status-badge')).toContainText('Paid', { timeout: 10000 });
  });

  test('downloading a payslip triggers a real browser download', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-payslip-button').first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain('.pdf');
  });

  test('bank export (run is FINALIZED/PAID) triggers a real browser download', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/payroll/${runId}`);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('bank-export-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain('.csv');
  });
});

test.describe('Payroll RBAC + tenant isolation', () => {
  test('a plain EMPLOYEE sees no "Payroll" nav entry and gets a graceful notice navigating there directly', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('a[href="/payroll"]')).toHaveCount(0);

    await page.goto('/payroll');
    await expect(page.getByRole('alert').or(page.getByRole('status'))).toBeVisible();
    await expect(page.getByTestId('payroll-run-row')).toHaveCount(0);
  });

  test('an EMPLOYEE in tenant B has no payroll access either — cross-tenant isolation holds structurally', async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await expect(page.locator('a[href="/payroll"]')).toHaveCount(0);

    await page.goto('/payroll');
    await expect(page.getByRole('alert').or(page.getByRole('status'))).toBeVisible();
    await expect(page.getByTestId('payroll-run-row')).toHaveCount(0);
  });
});
