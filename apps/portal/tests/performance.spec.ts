import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

// Module-scoped (not `describe.serial`-scoped) because the trailing RBAC
// block below also needs `appraisalId`, once the serial lifecycle block has
// created it.
let cycleId: string;
let appraisalId: string;

/**
 * The Performance console, end to end against the real API/Postgres stack —
 * no mocks, matching every other spec in this directory. One
 * `describe.serial` block: cycle create -> open (auto-enrollment) -> peer
 * assignment -> peer review submission -> submit-for-approval -> manager
 * sign-off is inherently a single stateful lifecycle. The cycle's
 * `enabledReviewTypes` is deliberately set to `['PEER']` only — see
 * docs/conventions/performance.md's enrollment section: with no SELF/
 * MANAGER/UPWARD types enabled, `AppraisalCycleService.open` auto-creates
 * zero `ReviewAssignment` rows, so the ONLY assignment on employeeA's
 * appraisal is the one explicit peer assignment this suite makes — avoiding
 * the need to drive multiple reviewers to SUBMITTED just to reach
 * "every assignment SUBMITTED".
 *
 * Calibration rendering is proven against a SEPARATE, already-seeded cycle
 * (`fixtures.calibrationCycleId`, with precomputed
 * `AppraisalRatingDistributionSnapshot` rows — see global-setup.ts) rather
 * than the cycle this suite drives through the UI, since a real appraisal
 * would need to reach COMPLETED (full review + sign-off) before the real
 * `CalibrationProcessor` ever produces a rollup row for it.
 */
test.describe.serial('Performance console', () => {
  test('HR/admin confirms the seeded rating scale is selectable, then creates a cycle scoped to the US branch with PEER review only', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/performance');
    await expect(page.getByTestId('new-cycle-button')).toBeVisible();
    await page.getByTestId('new-cycle-button').click();

    await page.locator('#cycle-name').fill('Portal E2E Annual Cycle');
    await page.locator('#cycle-start-date').fill('2026-01-01');
    await page.locator('#cycle-end-date').fill('2026-12-31');

    // The rating scale seeded in global-setup.ts must already be selectable.
    await expect(page.locator('#cycle-rating-scale')).toContainText(fixtures.ratingScaleName);
    await page.locator('#cycle-rating-scale').selectOption(fixtures.ratingScaleKey);

    // Only PEER is enabled — SELF/MANAGER are checked by default, uncheck them.
    await page.getByTestId('review-type-SELF').uncheck();
    await page.getByTestId('review-type-MANAGER').uncheck();
    await page.getByTestId('review-type-PEER').check();

    await page.getByTestId(`eligible-branch-${fixtures.branchAUsId}`).check();

    await page.getByTestId('submit-new-cycle-button').click();

    await page.waitForURL('**/performance/*');
    const url = new URL(page.url());
    cycleId = url.pathname.split('/').pop()!;
    expect(cycleId).toBeTruthy();
    await expect(page.getByTestId('cycle-status-badge')).toContainText('Draft');
  });

  test('Opening the cycle auto-enrolls eligible employees with zero separate "enroll" action', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/performance/${cycleId}`);

    await page.getByTestId('open-cycle-button').click();
    await expect(page.getByTestId('cycle-status-badge')).toContainText('Open', { timeout: 10000 });

    await expect(page.getByTestId('appraisal-row').first()).toBeVisible();
    const rowsCount = await page.getByTestId('appraisal-row').count();
    expect(rowsCount).toBeGreaterThan(0);

    const targetRow = page.locator(`[data-testid="appraisal-row"][data-employee-id="${fixtures.employeeAId}"]`);
    await expect(targetRow).toHaveCount(1);
    await targetRow.click();

    await page.waitForURL('**/performance/appraisals/*');
    const url = new URL(page.url());
    appraisalId = url.pathname.split('/').pop()!;
    expect(appraisalId).toBeTruthy();
    await expect(page.getByTestId('appraisal-status-badge')).toContainText('Draft');
    // Zero auto-created assignments (only PEER was enabled, never auto-resolved).
    await expect(page.getByTestId('assignment-row')).toHaveCount(0);
  });

  test('HR/admin assigns a peer reviewer via the UI', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/performance/appraisals/${appraisalId}`);

    await page.getByTestId('assign-peers-button').click();
    // Picking a US-branch (English/LTR Country Pack) reviewer deliberately —
    // the QA-branch employee's own session correctly renders in Arabic per
    // the resolved Country Pack (see docs/conventions/i18n-timezone-rtl.md),
    // which would make this spec's later English-text assertions brittle
    // for the wrong reason (a correctly-localized UI, not a bug).
    const candidateRow = page.locator('label', { hasText: 'Rana Restricted' });
    await candidateRow.locator('input[type="checkbox"]').check();
    await page.getByTestId('submit-peers-button').click();

    await expect(page.getByTestId('assignment-row')).toHaveCount(1);
    await expect(page.getByTestId('assignment-row')).toContainText('Peer');
    await expect(page.getByTestId('assignment-row')).toContainText('Pending');
  });

  test('the assigned peer reviewer submits their review via /performance/my-reviews', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.branchRestrictedManagerEmail);
    await page.goto('/performance/my-reviews');

    await expect(page.getByTestId('review-assignment-row')).toHaveCount(1);
    await expect(page.getByTestId('review-assignment-row')).toContainText('Peer');

    await page.getByTestId('submit-review-button').click();
    await page.locator('#review-overall-rating').fill('4');
    await page.locator('#review-strengths').fill('Great collaborator.');
    await page.locator('#review-improvements').fill('Could delegate more.');
    await page.getByTestId('submit-review-form-button').click();

    await expect(page.getByTestId('review-assignment-row')).toHaveCount(0);
    await expect(page.getByText('No pending review assignments')).toBeVisible();
  });

  // Split into two tests (one login each) rather than one test that logs in
  // twice — re-navigating to `/login` on a page that already holds a valid
  // session redirects client-side before the form is interactable, which is
  // exactly the flakiness `payroll.spec.ts` avoids by giving every distinct
  // actor its own test within the same `describe.serial` block.
  test('HR/admin submits the appraisal for approval, surfacing the WorkflowStatusPanel', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/performance/appraisals/${appraisalId}`);

    await expect(page.getByTestId('assignment-row')).toContainText('Submitted');
    await expect(page.getByTestId('submit-for-approval-button')).toBeVisible();
    await page.getByTestId('submit-for-approval-button').click();

    await expect(page.getByTestId('workflow-status-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('appraisal-status-badge')).toContainText('Pending sign-off');
  });

  // `AppraisalService.findById` only allows the appraised employee
  // themself OR a `performance.manage` holder to view
  // `GET /performance/appraisals/:id` (see docs/conventions/performance.md
  // — MANAGER holds `performance.review`/`.read`/`.write` but NOT
  // `.manage`, which is TENANT_ADMIN/HR_MANAGER only). So employeeA's own
  // manager — the resolved approver — cannot reach the appraisal detail
  // page's embedded `WorkflowStatusPanel` at all; they approve via the
  // SAME generic, entity-type-agnostic `/approvals` inbox every other
  // workflow-driven module in this codebase already uses (per the plan's
  // own finding: "the existing approvals inbox needs zero code changes" to
  // pick up a new entity type).
  test("the appraised employee's manager approves it via the /approvals inbox", async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
    await page.goto('/approvals');

    const card = page.locator('[data-testid="approval-card"][data-entity-type="PerformanceAppraisal"]');
    await expect(card).toBeVisible();
    await card.getByTestId('approve-button').click();
    await expect(card).toHaveCount(0);
  });

  test('HR/admin sees the appraisal reach COMPLETED', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/performance/appraisals/${appraisalId}`);

    await waitFor(async () => {
      await page.getByTestId('refresh-button').click();
      const text = await page.getByTestId('appraisal-status-badge').innerText();
      return text.includes('Completed') ? true : null;
    }, 20000, 500);
  });

  test('the calibration section on a separately seeded cycle renders precomputed rollup rows', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/performance/${fixtures.calibrationCycleId}`);

    await expect(page.getByTestId('calibration-row')).toHaveCount(2);
    const ratingValues = await page.getByTestId('calibration-rating-value').allInnerTexts();
    expect(ratingValues.sort()).toEqual(['3', '5']);
    const employeeCounts = await page.getByTestId('calibration-employee-count').allInnerTexts();
    expect(employeeCounts.sort()).toEqual(['1', '2']);
  });
});

test.describe('Performance RBAC', () => {
  test('a plain EMPLOYEE can see /performance and my-reviews (holds performance.read/review) but not cycle-management actions', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);

    await expect(page.locator('a[href="/performance"]')).toHaveCount(1);
    await page.goto('/performance');
    await expect(page.getByTestId('new-cycle-button')).toHaveCount(0);
    await expect(page.getByTestId('open-cycle-button')).toHaveCount(0);
    await expect(page.getByTestId('close-cycle-button')).toHaveCount(0);
    await expect(page.getByTestId('cycle-row').first()).toBeVisible();

    await page.getByTestId('my-reviews-link').click();
    await page.waitForURL('**/performance/my-reviews');
    await expect(page.getByRole('heading', { name: 'My reviews' })).toBeVisible();
  });

  test('an EMPLOYEE cannot manage a cycle or assign peers even navigating directly', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);

    await page.goto(`/performance/appraisals/${appraisalId}`);
    await expect(page.getByTestId('assign-peers-button')).toHaveCount(0);
    await expect(page.getByTestId('submit-for-approval-button')).toHaveCount(0);
  });
});
