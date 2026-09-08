import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Polls the batch detail page's own in-app "Refresh" button (a lightweight
 * client-side re-fetch via `useAsync`'s `reload()`) rather than
 * `page.reload()` — the SAME `payroll.spec.ts`-established lesson (see that
 * file's own doc comment): a full browser navigation is slower AND risks
 * repeatedly wiping the in-memory access token, forcing a fresh
 * `POST /auth/refresh` on every reload, which can trip 0.4's refresh-token
 * reuse-detection guard and silently log the session out mid-poll.
 */
async function refreshUntil(page: Page, check: () => Promise<boolean>): Promise<void> {
  await waitFor(
    async () => {
      await page.getByTestId('refresh-batch-button').click();
      return (await check()) ? true : null;
    },
    20000,
    500,
  );
}

/**
 * The data migration & onboarding toolkit's import wizard (step 3.5.1),
 * end to end against the real API/Postgres/Redis/MinIO stack — no mocks,
 * matching every other spec in this directory. See
 * docs/conventions/data-migration.md.
 *
 * ONE LOGIN PER TEST across sequential steps of the SAME flow, threaded
 * through a `describe.serial` block with a closure-held batch id — the
 * SAME shape `operations-modules.spec.ts`/`payroll.spec.ts` already
 * establish for a genuinely stateful multi-step flow.
 */
test.describe.serial('Data import wizard', () => {
  test('admin uploads a file, maps columns, runs a dry run, reviews the summary, and commits', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/migration');
    await expect(page.getByTestId('new-import-button')).toBeVisible();
    await page.getByTestId('new-import-button').click();
    await page.waitForURL('**/migration/new');

    await page.getByTestId('import-entity-type-select').selectOption('DESIGNATION');

    // The second data row has a blank "Title" — a real, reportable row
    // error, proving the error-report download path below.
    const messyCsv = 'Title,Other\nSoftware Engineer (E2E),ok\n,this row has no title';
    await page.getByTestId('import-file-input').setInputFiles({ name: 'designations.csv', mimeType: 'text/csv', buffer: Buffer.from(messyCsv) });
    await page.getByTestId('continue-to-mapping-button').click();

    await expect(page.getByTestId('mapping-select-name')).toBeVisible();
    await page.getByTestId('mapping-select-name').selectOption('Title');
    await page.getByTestId('run-dry-run-button').click();

    await page.waitForURL(/\/migration\/[^/]+$/);
    await refreshUntil(page, () => page.getByText('Dry run complete').isVisible());
    await expect(page.getByText('Dry run complete')).toBeVisible();

    await expect(page.getByTestId('import-row-error')).toHaveCount(1);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-error-report-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain('.csv');

    await page.getByTestId('commit-batch-button').click();
    await page.getByTestId('confirm-commit-button').click();

    // The messy file has one deliberately bad row (see `messyCsv` above),
    // so the correct terminal status is COMMITTED_WITH_ERRORS — one valid
    // row committed, one reported — not a clean COMMITTED.
    await refreshUntil(page, () => page.getByText('Committed with errors').isVisible());
    await expect(page.getByText('Committed with errors')).toBeVisible();

    await page.goto('/migration');
    await expect(page.getByTestId('import-batch-row').first()).toBeVisible();
  });

  test('a saved column-mapping template can be reused for a second import', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto('/migration/new');

    await page.getByTestId('import-entity-type-select').selectOption('DESIGNATION');
    await page.getByTestId('import-file-input').setInputFiles({ name: 'designations-2.csv', mimeType: 'text/csv', buffer: Buffer.from('Title\nProduct Manager (E2E)') });
    await page.getByTestId('continue-to-mapping-button').click();

    await page.getByTestId('mapping-select-name').selectOption('Title');
    await page.check('input[type="checkbox"]');
    await page.getByTestId('mapping-template-name-input').fill('E2E Designation Mapping');
    await page.getByTestId('run-dry-run-button').click();
    await page.waitForURL(/\/migration\/[^/]+$/);

    await page.goto('/migration/new');
    await page.getByTestId('import-entity-type-select').selectOption('DESIGNATION');
    await page.getByTestId('import-file-input').setInputFiles({ name: 'designations-3.csv', mimeType: 'text/csv', buffer: Buffer.from('Title\nData Analyst (E2E)') });
    await page.getByTestId('continue-to-mapping-button').click();

    await expect(page.getByTestId('mapping-template-select')).toBeVisible();
    await page.getByTestId('mapping-template-select').selectOption({ label: 'E2E Designation Mapping' });
    await expect(page.getByTestId('mapping-select-name')).toHaveValue('Title');
  });

  test('a plain employee has no Data import nav item', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: /data import/i })).toHaveCount(0);
  });
});
