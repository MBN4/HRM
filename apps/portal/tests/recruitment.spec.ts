import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { prisma } from '@hrm/db';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const REQUISITION_TITLE = 'Portal E2E QA Engineer Requisition';
const POSTING_TITLE = 'Portal E2E QA Engineer Posting';

/**
 * Polls an in-app "Refresh" button (a lightweight client-side `useAsync`
 * `reload()`) rather than `page.reload()` — same posture `payroll.spec.ts`/
 * `performance.spec.ts` already establish for state that changes
 * asynchronously server-side (a fire-and-forget workflow-decision event
 * listener, or the `recruitment.offer_accepted` -> onboarding-start event).
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
 * Recruitment (ATS) + Onboarding + Offboarding, end to end against the real
 * API/Postgres/Redis stack — no mocks. This is ONE connected chain (offer-
 * accept auto-starts onboarding; offboarding is a separate lifecycle) built
 * as a single `describe.serial` block, one login per test (avoids the
 * auth-redirect flakiness Stage 5 discovered), sharing state purely through
 * fixed identifiers (candidate/employee ids from `global-setup.ts`) and
 * DOM lookups — never a direct API call to fake a step forward.
 */
test.describe.serial('Recruitment + Onboarding + Offboarding console', () => {
  test('HR/admin creates a requisition, submits it for approval, and approves it via the inline WorkflowStatusPanel', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment');

    await page.getByTestId('new-requisition-button').click();
    await page.locator('#requisition-title').fill(REQUISITION_TITLE);
    await page.locator('#requisition-branch').selectOption(fixtures.branchAUsId);
    await page.locator('#requisition-headcount').fill('2');
    await page.locator('#requisition-justification').fill('Team growth.');
    await page.getByTestId('submit-new-requisition-button').click();

    const row = page.locator('[data-testid="requisition-row"]', { hasText: REQUISITION_TITLE });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'DRAFT');

    await row.getByTestId('submit-requisition-button').click();
    await expect(row).toHaveAttribute('data-status', 'PENDING_APPROVAL', { timeout: 10000 });

    await row.getByRole('button', { name: REQUISITION_TITLE }).click();
    await expect(page.getByTestId('workflow-status-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('workflow-step-row')).toHaveCount(1);

    // The seeded JobRequisition workflow template uses a `ROLE: TENANT_ADMIN`
    // approver rule (see global-setup.ts) — the SAME admin who submitted the
    // requisition is eligible to approve it inline, no re-login needed.
    await page.getByTestId('approve-button').click();
    await refreshUntil(page, async () => (await row.getAttribute('data-status')) === 'APPROVED');
  });

  test('HR/admin creates a posting from the approved requisition, then publishes it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment');
    await page.getByTestId('postings-tab').click();
    await page.getByTestId('new-posting-button').click();

    await page.locator('#posting-requisition').selectOption({ label: REQUISITION_TITLE });
    await page.locator('#posting-title').fill(POSTING_TITLE);
    await page.locator('#posting-description').fill('We are hiring a QA engineer for the US team.');
    await page.locator('#posting-slug').fill('portal-e2e-qa-engineer');
    await page.getByTestId('submit-new-posting-button').click();

    const row = page.locator('[data-testid="posting-row"]', { hasText: POSTING_TITLE });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'DRAFT');

    await row.getByTestId('publish-posting-button').click();
    await expect(row).toHaveAttribute('data-status', 'PUBLISHED', { timeout: 10000 });
  });

  test('the pipeline board moves the seeded candidate application through stages', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment/candidates');

    const card = page.locator('[data-testid="application-card"]', { hasText: fixtures.seededCandidateName });
    await expect(page.getByTestId('pipeline-column-APPLIED')).toContainText(fixtures.seededCandidateName);

    await card.getByTestId('application-stage-select').selectOption('SCREEN');
    await expect(page.getByTestId('pipeline-column-SCREEN')).toContainText(fixtures.seededCandidateName);

    await card.getByTestId('application-stage-select').selectOption('INTERVIEW');
    await expect(page.getByTestId('pipeline-column-INTERVIEW')).toContainText(fixtures.seededCandidateName);
  });

  test('an interview is scheduled (interviewer picked from listEmployees) and a scorecard is submitted', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/candidates/${fixtures.seededCandidateId}`);

    await expect(page.getByTestId('application-block')).toBeVisible();
    await page.getByTestId('schedule-interview-button').click();

    await page.locator('#interview-scheduled-at').fill('2027-01-15T10:00');
    await page.locator('#interview-duration').fill('45');
    await page.locator('label', { hasText: 'Mona Manager' }).locator('input[type="checkbox"]').check();
    await page.getByTestId('submit-schedule-interview-button').click();

    await expect(page.getByTestId('interview-row')).toBeVisible();

    // Admin holds `recruitment.manage`, so they can submit a scorecard even
    // though they aren't on the interview panel themselves (see
    // `InterviewService.submitScorecard`'s row-level gating).
    await page.getByTestId('submit-scorecard-button').click();
    await page.locator('#scorecard-rating').fill('4');
    await page.locator('#scorecard-recommendation').selectOption('YES');
    await page.locator('#scorecard-notes').fill('Strong candidate.');
    await page.getByTestId('submit-scorecard-form-button').click();

    await expect(page.getByTestId('scorecard-row')).toBeVisible();
  });

  test('an offer is created, submitted, approved via the panel, and accepted — auto-starting onboarding with zero direct API calls', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);

    await page.goto('/recruitment/candidates');
    const card = page.locator('[data-testid="application-card"]', { hasText: fixtures.seededCandidateName });
    await card.getByTestId('application-stage-select').selectOption('OFFER');
    await expect(page.getByTestId('pipeline-column-OFFER')).toContainText(fixtures.seededCandidateName);

    await page.goto('/recruitment/offers');
    await page.getByTestId('new-offer-button').click();
    await page.locator('#offer-application').selectOption({ index: 1 });
    await page.locator('#offer-branch').selectOption(fixtures.branchAUsId);
    await page.locator('#offer-join-date').fill('2027-02-01');
    await page.locator('#offer-salary').fill('90000');
    await page.locator('#offer-currency').fill('USD');
    await page.getByTestId('submit-new-offer-button').click();

    const row = page.locator('[data-testid="offer-row"]').first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'DRAFT');

    await row.getByTestId('submit-offer-button').click();
    await expect(row).toHaveAttribute('data-status', 'PENDING_APPROVAL', { timeout: 10000 });

    await row.locator('button').first().click();
    await expect(page.getByTestId('workflow-status-panel')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('approve-button').click();
    await refreshUntil(page, async () => (await row.getAttribute('data-status')) === 'APPROVED');

    await row.getByTestId('accept-offer-button').click();
    await expect(row).toHaveAttribute('data-status', 'ACCEPTED', { timeout: 10000 });
    await expect(page.getByText('Onboarding has started.')).toBeVisible();

    await page.goto('/recruitment/onboarding');
    await refreshUntil(
      page,
      async () => (await page.locator(`[data-testid="onboarding-process-row"][data-candidate-id="${fixtures.seededCandidateId}"]`).count()) > 0,
    );
    const processRow = page.locator(`[data-testid="onboarding-process-row"][data-candidate-id="${fixtures.seededCandidateId}"]`);
    await expect(processRow).toHaveAttribute('data-status', 'IN_PROGRESS');
  });

  test('onboarding: creating the employee first fails without required statutory fields, then succeeds once supplied', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment/onboarding');

    const row = page.locator(`[data-testid="onboarding-process-row"][data-candidate-id="${fixtures.seededCandidateId}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId('create-employee-button').click();

    await page.locator('#onboarding-employee-code').fill('PE-ONB-1');
    await page.getByTestId('submit-create-employee-button').click();
    await expect(page.getByRole('alert').filter({ hasText: /statutory field/i })).toBeVisible();

    await page.getByTestId('statutory-field-key').first().fill('SSN');
    await page.getByTestId('statutory-field-value').first().fill('987-65-4321');
    await page.getByTestId('add-statutory-field-button').click();
    await page.getByTestId('statutory-field-key').nth(1).fill('W4');
    await page.getByTestId('statutory-field-value').nth(1).fill('on-file');
    await page.getByTestId('submit-create-employee-button').click();

    await expect(page.getByTestId('submit-create-employee-button')).toHaveCount(0, { timeout: 10000 });
    await refreshUntil(page, async () => (await row.getAttribute('data-status')) === 'COMPLETED');
  });

  test('onboarding: admin completes the assigned checklist tasks, including one requiring a document upload', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment/onboarding');

    await expect(page.getByTestId('checklist-task-row')).toHaveCount(2, { timeout: 10000 });

    const simpleTask = page.getByTestId('checklist-task-row').filter({ hasText: 'Send welcome pack' });
    await simpleTask.getByTestId('complete-task-button').click();
    await expect(simpleTask).toHaveCount(0);

    const docTask = page.getByTestId('checklist-task-row').filter({ hasText: 'Upload signed contract' });
    await docTask.getByTestId('task-document-input').setInputFiles({
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test contract'),
    });
    await docTask.getByTestId('complete-task-button').click();

    await expect(page.getByText('No tasks assigned to you.')).toBeVisible();
  });

  test('offboarding: HR/admin initiates offboarding for a dedicated employee', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment/offboarding');

    await page.getByTestId('initiate-offboarding-button').click();
    await page.locator('#offboarding-employee').selectOption(fixtures.offboardingTargetEmployeeId);
    await page.locator('#offboarding-reason').selectOption('RESIGNATION');
    await page.locator('#offboarding-last-working-date').fill('2027-03-01');
    await page.getByTestId('submit-initiate-offboarding-button').click();

    const row = page.locator('[data-testid="offboarding-process-row"]', { hasText: fixtures.offboardingTargetEmployeeId });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'PENDING_APPROVAL');
  });

  // `OffboardingController`'s `GET processes/:id` is gated on
  // `offboarding.manage` only — MANAGER (the resolved approver, via the
  // `MANAGER`-rule template) does NOT hold it, so managerA cannot reach the
  // process detail's embedded `WorkflowStatusPanel` at all. They approve via
  // the SAME generic `/approvals` inbox every other workflow-driven module
  // in this codebase already uses.
  test("offboarding: the departing employee's manager approves it via the /approvals inbox", async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.goto('/approvals');

    const card = page.locator('[data-testid="approval-card"][data-entity-type="OffboardingProcess"]');
    await expect(card).toBeVisible();
    await card.getByTestId('approve-button').click();
    await expect(card).toHaveCount(0);
  });

  test('offboarding: admin clears the checklist and completes the process, producing a FINAL_SETTLEMENT payroll run', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/recruitment/offboarding');

    const row = page.locator('[data-testid="offboarding-process-row"]', { hasText: fixtures.offboardingTargetEmployeeId });
    await refreshUntil(page, async () => (await row.getAttribute('data-status')) === 'APPROVED');

    await expect(page.getByTestId('checklist-task-row')).toHaveCount(2, { timeout: 10000 });
    await page.getByTestId('checklist-task-row').filter({ hasText: 'Return company equipment' }).getByTestId('complete-task-button').click();
    // Wait for the first task's completion to fully round-trip (the list's
    // own `reload()` briefly swaps to a loading spinner, unmounting/
    // remounting every row including its file input) before interacting
    // with the second task — otherwise `setInputFiles` can land on an
    // input that gets torn down mid-interaction by that reload.
    await expect(page.getByTestId('checklist-task-row')).toHaveCount(1, { timeout: 10000 });

    const docTask = page.getByTestId('checklist-task-row').filter({ hasText: 'Upload signed exit interview form' });
    await docTask.getByTestId('task-document-input').setInputFiles({
      name: 'exit-form.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 exit form'),
    });
    await docTask.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('checklist-task-row')).toHaveCount(0, { timeout: 10000 });

    // Fresh navigation so the expandable process panel (its own `useAsync`,
    // independent of the "my tasks" list above) re-fetches the now-COMPLETED
    // tasks — the client-side "not all completed" notice is a UX nicety
    // only, the backend re-checks authoritatively regardless.
    await page.goto('/recruitment/offboarding');
    await row.click();
    await expect(page.getByTestId('complete-offboarding-button')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('complete-offboarding-button').click();

    await expect(page.getByTestId('settlement-run-link')).toBeVisible({ timeout: 15000 });
    const href = await page.getByTestId('settlement-run-link').getAttribute('href');
    const runId = href!.split('/').pop()!;

    const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
    expect(run?.runType).toBe('FINAL_SETTLEMENT');
    expect(run?.branchId).toBe(fixtures.branchAUsId);
  });
});

test.describe('Recruitment RBAC + tenant isolation', () => {
  test('MANAGER (recruitment.read/write, not .manage) sees /recruitment but not manage-gated actions, and no onboarding/offboarding nav entries', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);

    await expect(page.locator('a[href="/recruitment"]')).toHaveCount(1);
    await expect(page.locator('a[href="/recruitment/onboarding"]')).toHaveCount(0);
    await expect(page.locator('a[href="/recruitment/offboarding"]')).toHaveCount(0);

    // Stay on the SAME page load from here on (client-side tab toggle, no
    // further `page.goto()`) — stacking multiple full-page reloads within
    // one login session can race the refresh-token rotation each reload
    // triggers (in-memory access token is wiped every reload) and trip the
    // auth layer's reuse-detection guard, logging the session out entirely.
    // `/recruitment/onboarding` and `/recruitment/offboarding` are checked
    // in their own freshly-logged-in tests below instead.
    await page.goto('/recruitment');
    await expect(page.getByTestId('new-requisition-button')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('submit-requisition-button')).toHaveCount(0);
    await expect(page.getByTestId('close-requisition-button')).toHaveCount(0);

    await page.getByTestId('postings-tab').click();
    await expect(page.getByTestId('new-posting-button')).toHaveCount(0);
    await expect(page.getByTestId('publish-posting-button')).toHaveCount(0);
  });

  test('MANAGER lacking onboarding.manage sees the forbidden notice at /recruitment/onboarding', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.goto('/recruitment/onboarding');
    await expect(page.getByRole('status').filter({ hasText: /./ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('onboarding-process-row')).toHaveCount(0);
  });

  test('MANAGER lacking offboarding.manage sees the forbidden notice at /recruitment/offboarding', async ({ page }) => {
    // A second, independent MANAGER-role fixture (same role/permissions,
    // just branch-restricted) — spreads this file's manager logins across
    // two distinct `{tenantId, email}` rate-limit counters (0.4's real
    // 5-attempts/15-minute login guard) rather than clustering them all on
    // one email, which was tripping it when this suite runs repeatedly.
    await login(page, fixtures.tenantASlug, fixtures.branchRestrictedManagerEmail);
    await page.goto('/recruitment/offboarding');
    await expect(page.getByRole('status').filter({ hasText: /./ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('offboarding-process-row')).toHaveCount(0);
  });

  test('an EMPLOYEE in tenant B has no recruitment access either — cross-tenant isolation holds structurally', async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await expect(page.locator('a[href="/recruitment"]')).toHaveCount(0);

    await page.goto('/recruitment');
    await expect(page.getByRole('status').filter({ hasText: /./ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('requisition-row')).toHaveCount(0);
  });
});
