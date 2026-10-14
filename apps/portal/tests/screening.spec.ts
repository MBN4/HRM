import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { prisma, SYSTEM_ROLES } from '@hrm/db';
import { parsedResumeSchema } from '@hrm/shared';
import { FIXTURES_PATH, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

const REQ_TITLE = 'Portal E2E Screening Requisition';
const SLUG = `portal-e2e-screening-${Date.now()}`;

const GOOD_RESUME = `Nadia Newton
nadia.newton@screening-e2e.test
Skills
TypeScript, NestJS, PostgreSQL, Docker
Work Experience
Backend Engineer at Orbit Labs
Jan 2016 - Present
- Built payments APIs.
Education
Bachelor of Science in Computer Science
State University, 2015
`;

/**
 * Resume parsing + screening (step 9.1) in a real browser against the real
 * API/Postgres/Redis/BullMQ stack: criteria as config data, a ranked list
 * with a transparent matched/missed breakdown, async parsing (a real TXT
 * upload parsed by the worker), a graceful unparseable-file path with manual
 * entry, recruiter edits feeding screening, human-only stage changes, RBAC,
 * cross-tenant isolation, and RTL.
 */
test.describe.serial('Resume parsing + candidate screening', () => {
  let requisitionId: string;
  let postingId: string;
  let strongCandidateId: string;
  let weakCandidateId: string;
  let strongApplicationId: string;
  let weakApplicationId: string;

  async function seedParsedCandidate(tenantId: string, postingId_: string, first: string, last: string, skills: string[], years: number, level: 'BACHELOR' | 'DIPLOMA') {
    const email = `${first}.${last}@screening-e2e.test`.toLowerCase();
    const parsed = parsedResumeSchema.parse({ fullName: `${first} ${last}`, email, skills, experience: [], education: [{ level, degree: 'Degree' }], totalYearsExperience: years, links: [], rawText: `${first} ${skills.join(' ')}` });
    const candidate = await prisma.candidate.create({
      data: { tenantId, firstName: first, lastName: last, email, source: 'e2e', parseStatus: 'PARSED', parsedData: parsed, parserName: 'e2e-seed', parsedAt: new Date() },
    });
    const application = await prisma.application.create({ data: { tenantId, candidateId: candidate.id, jobPostingId: postingId_ } });
    return { candidate, application };
  }

  test.beforeAll(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: fixtures.tenantASlug } });
    const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: fixtures.adminAEmail } });
    const requisition = await prisma.jobRequisition.create({
      data: { tenantId: tenant.id, title: REQ_TITLE, branchId: fixtures.branchAUsId, employmentType: 'FULL_TIME', headcount: 1, status: 'APPROVED', createdByUserId: admin.id },
    });
    requisitionId = requisition.id;
    const posting = await prisma.jobPosting.create({
      data: { tenantId: tenant.id, requisitionId, title: 'Portal E2E Screening Posting', description: 'x', publicSlug: SLUG, status: 'PUBLISHED', publishedAt: new Date() },
    });
    postingId = posting.id;
    const strong = await seedParsedCandidate(tenant.id, postingId, 'Sam', 'Strong', ['TypeScript', 'NestJS', 'PostgreSQL', 'AWS'], 8, 'BACHELOR');
    const weak = await seedParsedCandidate(tenant.id, postingId, 'Will', 'Weak', ['Excel'], 1, 'DIPLOMA');
    strongCandidateId = strong.candidate.id;
    weakCandidateId = weak.candidate.id;
    strongApplicationId = strong.application.id;
    weakApplicationId = weak.application.id;
  });

  const rowFor = (page: import('@playwright/test').Page, name: string) => page.locator('[data-testid="ranked-row"]', { hasText: name });

  test('with no criteria applicants are listed unscored; defining criteria scores + ranks them and explains why', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);

    await expect(page.getByTestId('no-criteria')).toBeVisible();
    await expect(rowFor(page, 'Sam Strong')).toBeVisible();
    await expect(rowFor(page, 'Sam Strong')).toHaveAttribute('data-score', '');

    await page.getByTestId('edit-criteria-button').click();
    await page.getByTestId('criteria-required-input').fill('typescript, nest.js, postgres');
    await page.getByTestId('criteria-preferred-input').fill('AWS');
    await page.getByTestId('criteria-years-input').fill('5');
    await page.locator('#sc-threshold').fill('50');
    await page.getByTestId('save-criteria-button').click();

    await expect(page.getByTestId('criteria-summary')).toContainText('NestJS');
    const strongRow = rowFor(page, 'Sam Strong');
    const weakRow = rowFor(page, 'Will Weak');
    await expect(strongRow).toHaveAttribute('data-score', '100');
    await expect(weakRow).toHaveAttribute('data-flagged', 'true');
    await expect(weakRow).toContainText(/below threshold/i);

    // Ranked: the strong applicant is listed above the weak one.
    const names = await page.locator('[data-testid="candidate-link"]').allTextContents();
    expect(names.indexOf('Sam Strong')).toBeLessThan(names.indexOf('Will Weak'));

    // Transparent: expand the weak applicant to see matched/missed criteria.
    await weakRow.getByTestId('why-button').click();
    const breakdown = page.getByTestId('screening-breakdown');
    await expect(breakdown).toBeVisible();
    await expect(breakdown.locator('[data-criterion="requiredSkills"]')).toContainText('TypeScript');
    await expect(breakdown.locator('[data-criterion="requiredSkills"]')).toHaveAttribute('data-status', 'MISSED');
    await expect(breakdown.locator('[data-criterion="experience"]')).toContainText('1 yrs');
  });

  test('filters narrow the list by score, skill and experience', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);
    await expect(rowFor(page, 'Will Weak')).toBeVisible();

    await page.getByTestId('filter-min-score').fill('90');
    await expect(rowFor(page, 'Will Weak')).toHaveCount(0);
    await expect(rowFor(page, 'Sam Strong')).toBeVisible();
    await page.getByTestId('filter-min-score').fill('');

    await page.getByTestId('filter-skill').fill('excel');
    await expect(rowFor(page, 'Sam Strong')).toHaveCount(0);
    await expect(rowFor(page, 'Will Weak')).toBeVisible();
    await page.getByTestId('filter-skill').fill('');

    await page.getByTestId('filter-min-years').fill('5');
    await expect(rowFor(page, 'Will Weak')).toHaveCount(0);
    await expect(rowFor(page, 'Sam Strong')).toBeVisible();
  });

  test('a recruiter adds an applicant with a real resume: it is parsed in the background and then scored', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);
    await page.getByTestId('add-applicant-button').click();
    await page.locator('#aa-first').fill('Nadia');
    await page.locator('#aa-last').fill('Newton');
    await page.locator('#aa-email').fill('nadia.newton@screening-e2e.test');
    await page.getByTestId('add-applicant-file').setInputFiles({ name: 'nadia.txt', mimeType: 'text/plain', buffer: Buffer.from(GOOD_RESUME) });
    await page.getByTestId('submit-add-applicant-button').click();

    const row = rowFor(page, 'Nadia Newton');
    await expect(row).toBeVisible({ timeout: 15000 });
    // The list polls while parsing; once parsed the row carries a score and the parsed skills.
    await expect(row).not.toHaveAttribute('data-score', '', { timeout: 30000 });
    await expect(row).toContainText('NestJS');
    expect(Number(await row.getAttribute('data-score'))).toBeGreaterThanOrEqual(70);
  });

  test('an unparseable file fails gracefully; the recruiter enters the fields by hand and the candidate is then screened', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);
    await page.getByTestId('add-applicant-button').click();
    await page.locator('#aa-first').fill('Fay');
    await page.locator('#aa-last').fill('Unreadable');
    await page.locator('#aa-email').fill('fay.unreadable@screening-e2e.test');
    await page.getByTestId('add-applicant-file').setInputFiles({ name: 'scan.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    await page.getByTestId('submit-add-applicant-button').click();

    const row = rowFor(page, 'Fay Unreadable');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText(/parse failed/i, { timeout: 30000 });
    await expect(row).toHaveAttribute('data-score', '');

    await row.getByTestId('candidate-link').click();
    await expect(page.getByTestId('parse-failed')).toBeVisible();
    await page.getByTestId('enter-manually-button').click();
    await page.getByTestId('parsed-skills-input').fill('TypeScript, NestJS, PostgreSQL');
    await page.getByTestId('parsed-years-input').fill('6');
    await page.getByTestId('save-parsed-button').click();
    await expect(page.getByTestId('parsed-fields')).toContainText('NestJS');
    await expect(page.getByTestId('application-screening').getByTestId('score-value')).not.toHaveText('', { timeout: 15000 });
  });

  test('editing parsed fields re-scores the candidate from the EDITED data', async ({ page }) => {
    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/candidates/${weakCandidateId}`);
    await expect(page.getByTestId('parsed-fields')).toBeVisible();
    await expect(page.getByTestId('application-screening').getByTestId('score-value')).not.toHaveText('100');

    await page.getByTestId('edit-parsed-button').click();
    await page.getByTestId('parsed-skills-input').fill('Excel, TypeScript, NestJS, PostgreSQL, AWS');
    await page.getByTestId('parsed-years-input').fill('7');
    await page.getByTestId('save-parsed-button').click();

    await expect(page.getByTestId('application-screening').getByTestId('score-value')).toHaveText('100', { timeout: 15000 });
    await expect(page.getByTestId('application-screening')).toContainText(/recruiter-edited/i);
    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: weakCandidateId } });
    expect(row.parsedDataEditedAt).not.toBeNull();
  });

  test('scoring never moves anyone — only the recruiter does (stage select)', async ({ page }) => {
    // Everything scored so far is still APPLIED (the flagged "Will Weak" was never auto-rejected).
    const before = await prisma.application.findMany({ where: { jobPostingId: postingId }, select: { stage: true } });
    expect(before.every((a) => a.stage === 'APPLIED')).toBe(true);

    await login(page, fixtures.tenantASlug, fixtures.adminAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);
    const row = rowFor(page, 'Sam Strong');
    await row.locator('select[data-testid="stage-select"]').selectOption('INTERVIEW');
    await waitFor(async () => (await prisma.application.findUniqueOrThrow({ where: { id: strongApplicationId } })).stage === 'INTERVIEW');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: weakApplicationId } })).stage).toBe('APPLIED');
  });

  test('RBAC: an employee without recruitment permissions is blocked; another tenant cannot see the requisition', async ({ page, browser }) => {
    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto(`/recruitment/screening/${requisitionId}`);
    await expect(page.getByText(/not allowed|forbidden|permission/i).first()).toBeVisible();
    await expect(page.getByTestId('ranked-table')).toHaveCount(0);

    const ctx = await browser.newContext();
    try {
      const other = await ctx.newPage();
      await login(other, fixtures.tenantBSlug, fixtures.adminBEmail);
      await other.goto(`/recruitment/screening/${requisitionId}`);
      await expect(other.getByTestId('ranked-table')).toHaveCount(0);
      await expect(other.getByTestId('screening-title')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('RTL + Arabic: a Doha-branch recruiter sees the screening page mirrored, in Arabic', async ({ page }) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: fixtures.tenantASlug } });
    const qaUser = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: fixtures.qaEmployeeAEmail } });
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.MANAGER } } });
    const grant = await prisma.userRole.create({ data: { tenantId: tenant.id, userId: qaUser.id, roleId: managerRole.id } });
    try {
      const qaRequisition = await prisma.jobRequisition.create({
        data: { tenantId: tenant.id, title: 'Doha Screening Requisition', branchId: fixtures.branchAQaId, employmentType: 'FULL_TIME', headcount: 1, status: 'APPROVED', createdByUserId: qaUser.id },
      });
      await login(page, fixtures.tenantASlug, fixtures.qaEmployeeAEmail);
      await page.goto(`/recruitment/screening/${qaRequisition.id}`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('screening-title')).toContainText('فرز المرشحين');
      await expect(page.getByTestId('no-criteria')).toContainText('معايير');
    } finally {
      await prisma.userRole.deleteMany({ where: { userId: grant.userId, roleId: grant.roleId } });
    }
  });
});
