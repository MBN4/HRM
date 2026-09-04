import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { prisma } from '@hrm/db';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';
import { loginEnrolled } from './helpers';

const fixtures: AdminTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

/**
 * Proves the vendor console's branding oversight surface (step 4.3) end to
 * end through the REAL UI — see docs/conventions/white-label.md. The
 * seeded tenant's own custom-domain request is created directly via
 * `prisma` (the same "no UI to drive this from the vendor side" shortcut
 * this suite already takes for e.g. seeding a target tenant user — real
 * *requests* originate on the TENANT PORTAL side, out of this app's own
 * scope; this suite's job is the OVERSIGHT actions on top of one).
 */
test.describe('branding oversight — the real UI', () => {
  let domainId: string;

  test.beforeAll(async () => {
    await prisma.tenantDomain.deleteMany({ where: { tenantId: fixtures.seededTenantId } });
    const domain = await prisma.tenantDomain.create({
      data: {
        tenantId: fixtures.seededTenantId,
        domain: `hr.admin-e2e-${randomUUID().slice(0, 8)}.example`,
        verificationToken: 'unused-fixture-token',
      },
    });
    domainId = domain.id;
  });

  test('the branding overview lists the seeded tenant with its pending domain', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.getByRole('link', { name: 'Branding' }).click();
    await page.waitForURL('**/branding');

    const row = page.getByRole('row').filter({ hasText: fixtures.seededTenantSlug });
    await expect(row).toBeVisible();
    await expect(row.getByText('PENDING VERIFICATION')).toBeVisible();
  });

  test('PLATFORM_SUPPORT can see the tenant detail branding card but not act on it', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledSupportEmail, TEST_PASSWORD, fixtures.enrolledSupportTotpSecret);
    await page.goto(`/tenants/${fixtures.seededTenantId}`);
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve manually' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset to defaults' })).toHaveCount(0);
  });

  test('PLATFORM_OWNER manually approves the domain — now VERIFIED — then provisions TLS', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.goto(`/tenants/${fixtures.seededTenantId}`);

    await page.getByRole('button', { name: 'Approve manually' }).click();
    await expect(page.getByText('VERIFIED', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Provision TLS' }).click();
    await expect(page.getByText('ISSUED', { exact: true })).toBeVisible();

    // The tenant's own audit trail records the SAME action, never silent — see AuditController.
    const auditEntry = await prisma.auditLog.findFirst({
      where: { tenantId: fixtures.seededTenantId, action: 'branding.tls_provisioned' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.actorPlatform).toBe(true);
  });

  test('resets the tenant branding back to defaults from the vendor console', async ({ page }) => {
    await loginEnrolled(page, fixtures.enrolledOwnerEmail, TEST_PASSWORD, fixtures.enrolledOwnerTotpSecret);
    await page.goto(`/tenants/${fixtures.seededTenantId}`);
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await page.getByRole('button', { name: 'Reset branding' }).click();
    await expect(page.getByText('Reset branding — irreversible')).toHaveCount(0);
  });

  test.afterAll(async () => {
    await prisma.tenantDomain.deleteMany({ where: { id: domainId } });
  });
});
