import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * The Learning & Development console (step 3.2), end to end against the
 * real API/Postgres/Redis/MinIO stack — no mocks, matching every other
 * spec in this directory. See docs/conventions/lms.md.
 *
 * ONE LOGIN PER TEST — the same lesson operations-modules.spec.ts/
 * frontend-admin-console.md already document: stacking multiple
 * page.goto()/login() calls within one test can race 0.4's refresh-token
 * rotation. Each flow gets its own `describe.serial` block, state threaded
 * through closure `let`s.
 */
test.describe.serial('Learning admin: authoring a course, content, and a quiz', () => {
  test('HR creates a category and a course, adds content and a quiz, then publishes it', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/learning/admin');

    await page.getByTestId('new-course-category-button').click();
    await page.locator('#course-category-code').fill('SAFETY-E2E');
    await page.locator('#course-category-name').fill('Safety');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Safety', { exact: false }).first()).toBeVisible();

    await page.getByTestId('new-course-button').click();
    await page.getByTestId('new-course-title-input').fill('Fire Safety E2E');
    await page.getByTestId('submit-new-course-button').click();
    await expect(page.getByTestId('course-admin-row').first()).toContainText('Fire Safety E2E');

    const row = page.getByTestId('course-admin-row').filter({ hasText: 'Fire Safety E2E' });
    await row.locator('summary').click();

    await row.getByTestId('content-item-title-input').fill('Fire safety handbook');
    await row.getByTestId('add-content-item-button').click();
    await expect(row.getByTestId('admin-content-item-row')).toHaveCount(1);

    await row.getByTestId('quiz-title-input').fill('Fire Safety Quiz');
    await row.getByTestId('save-quiz-button').click();
    await expect(row.getByTestId('add-question-form')).toBeVisible();

    await row.getByTestId('question-text-input').fill('What do you do first in a fire?');
    await row.getByTestId('add-question-button').click();
    await expect(row.getByTestId('admin-quiz-question-row')).toHaveCount(1);

    await row.getByTestId('publish-course-button').click();

    // Publishing reloads the whole course LIST — the SAME "list reload
    // unmounts every row" race documented in
    // docs/conventions/frontend-admin-console.md for MyTasksList — keep
    // re-expanding until the reload has landed and the row shows PUBLISHED.
    await waitFor(async () => {
      const freshRow = page.getByTestId('course-admin-row').filter({ hasText: 'Fire Safety E2E' });
      await freshRow.locator('summary').click();
      const text = await freshRow.innerText();
      return text.includes('Published') ? true : null;
    });
  });

  test('HR assigns the course to a report with a due date', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/learning/admin');

    const row = page.getByTestId('course-admin-row').filter({ hasText: 'Fire Safety E2E' });
    await row.locator('summary').click();

    await row.getByTestId('assign-training-employee-select').selectOption({ label: 'Mona Manager' });
    await row.getByTestId('assign-training-button').click();
    await expect(row.getByText('Fire Safety E2E')).toBeVisible();
  });
});

test.describe.serial('ESS: enroll, consume content, pass the quiz, and earn a certification', () => {
  test('employeeA self-enrolls in the published course', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/learning');

    const catalogRow = page.getByTestId('course-catalog-row').filter({ hasText: 'Fire Safety E2E' });
    await expect(catalogRow).toBeVisible();
    await catalogRow.getByTestId('view-course-link').click();

    await page.waitForURL('**/learning/**');
    await page.getByTestId('enroll-button').click();
    await expect(page.getByTestId('content-item-row').first()).toBeVisible();
  });

  test('completing the content item and passing the quiz completes the course and awards a certification', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/learning');
    const catalogRow = page.getByTestId('course-catalog-row').filter({ hasText: 'Fire Safety E2E' });
    await catalogRow.getByTestId('view-course-link').click();
    await page.waitForURL('**/learning/**');

    await page.getByTestId('mark-content-complete-button').click();
    await expect(page.getByTestId('content-item-row').first()).toContainText('Completed');

    await expect(page.getByTestId('quiz-taker')).toBeVisible();
    await page.getByText('Option A', { exact: false }).first().click();
    await page.getByTestId('submit-quiz-button').click();
    await expect(page.getByTestId('quiz-result-alert')).toContainText('100%', { timeout: 10000 });

    await page.goto('/learning');
    await expect(page.getByTestId('my-certification-row').first()).toContainText('Fire Safety E2E');
  });
});

test.describe.serial('Required-training compliance', () => {
  test('a new required-training rule flags an unenrolled employee as MISSING in the gaps drill-down', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/learning/admin/compliance');

    await page.getByTestId('new-required-training-button').click();
    await page.locator('select#required-training-course').selectOption({ label: 'Fire Safety E2E' });
    await page.locator('select#required-training-branch').selectOption({ label: 'Portal E2E US HQ' });
    await page.getByTestId('submit-required-training-button').click();
    await expect(page.getByTestId('required-training-row').first()).toContainText('Fire Safety E2E');

    await page.getByTestId('compliance-branch-select').selectOption({ label: 'Portal E2E US HQ' });
    await expect(page.getByTestId('compliance-gap-row').filter({ hasText: 'Mona Manager' })).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Learning nav visibility and cross-tenant isolation', () => {
  test('an author/manager sees the Learning admin nav entry', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await expect(page.locator('a[href="/learning/admin"]')).toBeVisible();
    await expect(page.locator('a[href="/learning"]')).toBeVisible();
  });

  test('a plain employee sees "My learning" but no admin nav entry', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await expect(page.locator('a[href="/learning"]')).toBeVisible();
    await expect(page.locator('a[href="/learning/admin"]')).toHaveCount(0);
  });

  test('tenant B sees no courses from tenant A', async ({ page }) => {
    await login(page, fixtures.tenantBSlug, fixtures.employeeBEmail);
    await page.goto('/learning');
    await expect(page.getByTestId('course-catalog-row')).toHaveCount(0);
  });
});
