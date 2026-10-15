import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Engagement & culture (step 10.1) portal UI — recognition, the company feed, surveys, the admin hub — end to end in
 * a real browser against the real API/Postgres/Redis stack.
 *
 * Unlike most specs here this one runs against the SEEDED demo tenant (`acme-demo`, `pnpm --filter @hrm/api run
 * seed:demo`) because the brief's fixtures (an OPEN identified + OPEN anonymous survey, org feed posts, an RTL Doha
 * employee) live there. It never assumes a pristine DB: every record it creates carries a per-run stamp, and the
 * surveys it publishes are closed again at the end.
 *
 * ONE LOGIN PER TEST (see operations-modules.spec.ts for why) — state is threaded through closure `let`s.
 */
const TENANT = 'acme-demo';
const PASSWORD = 'DemoPass-123!';
const API = 'http://localhost:3001';
const ADMIN = 'ceo@acme-demo.local'; // HR_MANAGER does NOT hold engagement.manage; the CEO/TENANT_ADMIN tier does.
const INTERN = 'intern@acme-demo.local';
const LEAD = 'lead@acme-demo.local';
const RTL_USER = 'demo.qa@acme-demo.local';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

const STAMP = Date.now().toString(36);
const KUDOS = `E2E kudos ${STAMP}`;
const IDENTIFIED_TITLE = `E2E Pulse ${STAMP}`;
const ANON_TITLE = `E2E Anonymous ${STAMP}`;
const ANNOUNCEMENT_TITLE = `E2E notice ${STAMP}`;

async function loginDemo(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#tenantSlug').fill(TENANT);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
}

async function apiToken(request: APIRequestContext, email: string): Promise<Record<string, string>> {
  const res = await request.post(`${API}/auth/login`, { headers: { 'x-tenant-id': TENANT }, data: { email, password: PASSWORD } });
  if (!res.ok()) throw new Error(`demo login ${email} failed (${res.status()}) — has the demo tenant been seeded? (pnpm --filter @hrm/api run seed:demo)`);
  return { 'x-tenant-id': TENANT, Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
}

async function axeClean(page: Page): Promise<void> {
  // Let entrance animations (KpiCard's fade-up) finish — axe would otherwise measure contrast mid-fade.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // Compact summary so a failure names the rule and the offending nodes, not a 500-line axe dump.
  expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''} :: ${n.html.slice(0, 160)}`).slice(0, 4) }))).toEqual([]);
}

/** Builds a survey through the real builder UI and saves it as a draft. */
async function buildSurvey(page: Page, opts: { title: string; anonymous: boolean; full: boolean }): Promise<void> {
  await page.getByTestId('new-survey-button').click();
  await expect(page.getByTestId('survey-builder')).toBeVisible();
  await page.locator('#survey-title').fill(opts.title);
  await page.getByTestId(opts.anonymous ? 'survey-anonymous-yes' : 'survey-anonymous-no').check();

  const questions = page.getByTestId('builder-question');
  await questions.nth(0).getByTestId('question-prompt').fill('How satisfied are you?');
  if (opts.full) {
    await page.getByTestId('add-question-button').click();
    await questions.nth(1).locator('select').first().selectOption('SINGLE_CHOICE');
    await questions.nth(1).getByTestId('question-prompt').fill('Favourite perk?');
    await questions.nth(1).getByTestId('option-label').nth(0).fill('Snacks');
    await questions.nth(1).getByTestId('option-label').nth(1).fill('Remote days');

    await page.getByTestId('add-question-button').click();
    await questions.nth(2).locator('select').first().selectOption('MULTI_CHOICE');
    await questions.nth(2).getByTestId('question-prompt').fill('Which channels do you use?');
    await questions.nth(2).getByTestId('option-label').nth(0).fill('Email');
    await questions.nth(2).getByTestId('option-label').nth(1).fill('Chat');

    await page.getByTestId('add-question-button').click();
    await questions.nth(3).locator('select').first().selectOption('TEXT');
    await questions.nth(3).getByTestId('question-prompt').fill('Anything else?');
    // Reorder: move the free-text question up and back down — exercises the move controls without changing the order.
    await page.getByRole('button', { name: /move question 4 up/i }).click();
    await page.getByRole('button', { name: /move question 3 down/i }).click();
  }
  await page.getByTestId('save-survey-button').click();
  await expect(page.getByTestId('survey-admin-row').filter({ hasText: opts.title })).toBeVisible();
}

async function publishFromList(page: Page, title: string): Promise<void> {
  const row = page.getByTestId('survey-admin-row').filter({ hasText: title });
  await row.getByTestId('publish-survey-button').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(row.getByTestId('close-survey-button')).toBeVisible();
}

test.describe.serial('Engagement & culture UI', () => {
  test.beforeAll(async ({ request }) => {
    await apiToken(request, ADMIN); // fail fast with a clear message if the demo tenant is missing
  });

  test('(a) an employee gives PUBLIC recognition and it appears on the feed', async ({ page }) => {
    await loginDemo(page, INTERN);
    await page.goto('/recognition');
    await expect(page.getByRole('heading', { name: 'Recognition', level: 1 })).toBeVisible();
    await page.getByTestId('give-recognition-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('recipient-search').fill('CHAIN-CEO');
    await dialog.getByTestId('recipient-option').first().click();
    await expect(dialog.getByTestId('selected-recipient')).toContainText('Cora Executive');
    // You cannot recognize yourself: searching your own code offers nobody.
    await dialog.getByTestId('recipient-search').fill('CHAIN-INTERN');
    await expect(dialog.getByTestId('recipient-option')).toHaveCount(0);
    await expect(dialog.getByTestId('visibility-PUBLIC')).toBeChecked();
    await dialog.locator('#recognition-message').fill(KUDOS);
    await dialog.getByTestId('submit-recognition-button').click();
    await expect(page.getByText(/recognition sent/i)).toBeVisible();

    await page.getByTestId('tab-given').click();
    await expect(page.getByTestId('given-list')).toContainText(KUDOS);
    await expect(page.getByTestId('leaderboard')).toBeVisible();

    await page.goto('/feed');
    const card = page.getByTestId('feed-post').filter({ hasText: KUDOS });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-post-type', 'RECOGNITION');
    await expect(card).toContainText('Ivy Intern');
    await expect(card).toContainText('Cora Executive');
  });

  test('(b) another employee reacts to and comments on the recognition post', async ({ page }) => {
    await loginDemo(page, LEAD);
    await page.goto('/feed');
    const card = page.getByTestId('feed-post').filter({ hasText: KUDOS });
    await expect(card).toBeVisible();

    const like = card.getByTestId('react-LIKE');
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByTestId('count-LIKE')).toHaveText('1');
    await like.click(); // toggle off again
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await card.getByTestId('react-CELEBRATE').click();
    await expect(card.getByTestId('count-CELEBRATE')).toHaveText('1');

    await card.getByTestId('toggle-comments').click();
    await card.getByTestId('comment-input').fill(`Well deserved ${STAMP}`);
    await card.getByTestId('comment-submit').click();
    await expect(card.getByTestId('feed-comment').filter({ hasText: `Well deserved ${STAMP}` })).toBeVisible();
    await expect(card.getByTestId('toggle-comments')).toContainText('(1)');
    // A non-admin gets no moderation controls.
    await expect(card.getByTestId('remove-post-button')).toHaveCount(0);

    // Scope tabs: the Company tab still shows org-wide posts.
    await page.getByTestId('feed-scope-ORG').click();
    await expect(page.getByTestId('feed-post').first()).toBeVisible();
  });

  test('(d1) admin builds + publishes an identified and an anonymous survey in the builder', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/engagement');
    await expect(page.getByTestId('engagement-overview')).toBeVisible();
    await expect(page.getByTestId('kpi-recognitions')).not.toHaveText('');

    await page.getByTestId('hub-tab-surveys').click();
    // Client-side validation: an empty builder cannot be saved.
    await page.getByTestId('new-survey-button').click();
    await page.getByTestId('save-survey-button').click();
    await expect(page.getByRole('alert').filter({ hasText: /title/i })).toBeVisible();
    await page.getByRole('button', { name: /^cancel$/i }).click();

    await buildSurvey(page, { title: IDENTIFIED_TITLE, anonymous: false, full: true });
    await buildSurvey(page, { title: ANON_TITLE, anonymous: true, full: false });
    await publishFromList(page, IDENTIFIED_TITLE);
    await publishFromList(page, ANON_TITLE);
  });

  test('(c) an employee takes the identified survey (all four question types) and sees the anonymity banners', async ({ page }) => {
    await loginDemo(page, INTERN);
    await page.goto('/surveys');
    const row = page.getByTestId('my-survey-row').filter({ hasText: IDENTIFIED_TITLE });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'PENDING');
    await row.click();

    await expect(page.getByTestId('survey-title')).toHaveText(IDENTIFIED_TITLE);
    await expect(page.getByTestId('anonymity-banner')).toHaveAttribute('data-anonymous', 'false');
    await expect(page.getByTestId('anonymity-banner')).toContainText(/name is recorded/i);

    // Required-question validation.
    await page.getByTestId('submit-survey-button').click();
    await expect(page.getByRole('alert').filter({ hasText: /required/i })).toBeVisible();

    await page.getByTestId('rating-1-4').check({ force: true });
    await page.getByLabel('Remote days').check();
    await page.getByLabel('Chat').check();
    await page.getByLabel('Anything else?').fill('More team lunches please');
    await page.getByTestId('submit-survey-button').click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();

    // Re-opening is read-only now.
    await page.goto('/surveys');
    await page.getByTestId('my-survey-row').filter({ hasText: IDENTIFIED_TITLE }).click();
    await expect(page.getByTestId('survey-readonly')).toContainText(/already submitted/i);
    await expect(page.getByTestId('survey-form')).toHaveCount(0);

    // The anonymous one (created in d1) and the seeded anonymous one both show the prominent banner.
    await page.goto('/surveys');
    await page.getByTestId('my-survey-row').filter({ hasText: ANON_TITLE }).click();
    await expect(page.getByTestId('anonymity-banner')).toHaveAttribute('data-anonymous', 'true');
    await expect(page.getByTestId('anonymity-banner')).toContainText(/name is not stored/i);
    await page.getByTestId('rating-1-5').check({ force: true });
    await page.getByTestId('submit-survey-button').click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();

    await page.goto('/surveys');
    await page.getByTestId('my-survey-row').filter({ hasText: 'Anonymous culture check' }).click();
    await expect(page.getByTestId('anonymity-banner')).toHaveAttribute('data-anonymous', 'true');
  });

  test('(d2) admin sees aggregated results, the respondent table (identified only) and the anonymity suppression', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/engagement');
    await page.getByTestId('hub-tab-surveys').click();

    await page.getByTestId('survey-admin-row').filter({ hasText: IDENTIFIED_TITLE }).getByTestId('survey-results-link').click();
    await expect(page.getByTestId('results-title')).toHaveText(IDENTIFIED_TITLE);
    await expect(page.getByTestId('kpi-responses')).toHaveText('1');
    await expect(page.getByTestId('rating-average')).toHaveText('4');
    await expect(page.getByTestId('question-result')).toHaveCount(4);
    await expect(page.getByTestId('text-answers')).toContainText('More team lunches please');
    await expect(page.getByTestId('respondents-table')).toContainText('Ivy Intern');
    await expect(page.getByTestId('results-suppressed')).toHaveCount(0);

    await page.goto('/engagement');
    await page.getByTestId('hub-tab-surveys').click();
    await page.getByTestId('survey-admin-row').filter({ hasText: ANON_TITLE }).getByTestId('survey-results-link').click();
    await expect(page.getByTestId('results-title')).toHaveText(ANON_TITLE);
    await expect(page.getByTestId('results-suppressed')).toContainText(/hidden until at least 3/i);
    await expect(page.getByTestId('question-result')).toHaveCount(0);
    await expect(page.getByTestId('respondents-table')).toHaveCount(0);
  });

  test('(d3) admin closes the identified survey (and tidies the anonymous one)', async ({ page, request }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/engagement');
    await page.getByTestId('hub-tab-surveys').click();
    const row = page.getByTestId('survey-admin-row').filter({ hasText: IDENTIFIED_TITLE });
    await row.getByTestId('close-survey-button').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(row.getByTestId('close-survey-button')).toHaveCount(0);
    await expect(row).toContainText('Closed');

    // Tidy the anonymous survey through the API (it stays closed, never left open in the shared demo tenant).
    const headers = await apiToken(request, ADMIN);
    const list = (await (await request.get(`${API}/surveys`, { headers })).json()) as { id: string; title: string; status: string }[];
    for (const s of list.filter((x) => x.title === ANON_TITLE && x.status === 'OPEN')) {
      await request.post(`${API}/surveys/${s.id}/close`, { headers });
    }
  });

  test('(e) admin posts an announcement and moderates it (and a comment) away', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/feed');
    await page.getByTestId('new-announcement-post-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#feed-post-title').fill(ANNOUNCEMENT_TITLE);
    await dialog.locator('#feed-post-body').fill('Please remove me after the test.');
    await dialog.getByTestId('submit-announcement-button').click();

    const card = page.getByTestId('feed-post').filter({ hasText: ANNOUNCEMENT_TITLE });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-post-type', 'ANNOUNCEMENT');

    await card.getByTestId('toggle-comments').click();
    await card.getByTestId('comment-input').fill('temporary comment');
    await card.getByTestId('comment-submit').click();
    await expect(card.getByTestId('feed-comment')).toHaveCount(1);
    await card.getByTestId('remove-comment-button').click();
    await page.getByTestId('confirm-remove').click();
    await expect(card.getByTestId('feed-comment')).toHaveCount(0);

    await card.getByTestId('remove-post-button').click();
    await page.getByRole('dialog').locator('#moderation-reason').fill('E2E cleanup');
    await page.getByTestId('confirm-remove').click();
    await expect(page.getByTestId('feed-post').filter({ hasText: ANNOUNCEMENT_TITLE })).toHaveCount(0);

    // The recognition post from (a) is moderated too: removing it reverses its points and drops it from the feed.
    const kudos = page.getByTestId('feed-post').filter({ hasText: KUDOS });
    await kudos.getByTestId('remove-post-button').click();
    await page.getByTestId('confirm-remove').click();
    await expect(page.getByTestId('feed-post').filter({ hasText: KUDOS })).toHaveCount(0);
  });

  test('(e2) admin manages recognition values and generates celebrations from the hub', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/engagement');
    await page.getByTestId('hub-tab-categories').click();
    const name = `E2E value ${STAMP}`;
    await page.getByTestId('new-category-button').click();
    await page.locator('#category-name').fill(name);
    await page.locator('#category-points').fill('7');
    await page.getByTestId('save-category-button').click();
    const row = page.getByTestId('category-row').filter({ hasText: name });
    await expect(row).toContainText('7 pts');
    await row.getByTestId('toggle-category-button').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(row).toContainText('Inactive');

    await page.getByTestId('hub-tab-feed').click();
    await page.getByTestId('generate-celebrations-button').click();
    await expect(page.getByTestId('feed-tools-notice')).toContainText(/celebration post/i);
  });

  test('(f) a non-admin cannot reach the engagement hub and has no nav item for it', async ({ page }) => {
    await loginDemo(page, INTERN);
    await expect(page.locator('aside a[href="/recognition"]')).toBeVisible();
    await expect(page.locator('aside a[href="/feed"]')).toBeVisible();
    await expect(page.locator('aside a[href="/surveys"]')).toBeVisible();
    await expect(page.locator('aside a[href="/engagement"]')).toHaveCount(0);
    await page.goto('/engagement');
    await expect(page.getByText(/don't have permission/i)).toBeVisible();
    await expect(page.getByTestId('engagement-overview')).toHaveCount(0);
  });

  test('(f2) the admin nav shows the Engagement hub', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await expect(page.locator('aside a[href="/engagement"]')).toBeVisible();
  });

  test('(g) RTL: the Doha employee gets the feed, recognition form and survey mirrored in Arabic', async ({ page }) => {
    await loginDemo(page, RTL_USER);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    const viewportWidth = page.viewportSize()!.width;
    // The sidebar sits on the inline-start edge — the RIGHT edge under RTL.
    expect((await page.getByTestId('app-sidebar').boundingBox())!.x).toBeGreaterThan(viewportWidth / 2);

    await page.goto('/feed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('موجز الشركة');
    const post = page.getByTestId('feed-post').first();
    await expect(post).toBeVisible();
    expect(await post.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await axeClean(page);

    await page.goto('/recognition');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('التقدير');
    await page.getByTestId('give-recognition-button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await expect(dialog.getByTestId('visibility-PUBLIC')).toBeVisible();
    await axeClean(page);
    await page.keyboard.press('Escape');

    await page.goto('/surveys');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('الاستبيانات');
    await page.getByTestId('my-survey-row').filter({ hasText: 'Q4 Engagement Pulse' }).first().click();
    await expect(page.getByTestId('anonymity-banner')).toBeVisible();
    expect(await page.getByTestId('anonymity-banner').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await axeClean(page);
  });
});

test.describe('Engagement & culture accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('/feed, /recognition, /surveys (employee, LTR)', async ({ page }) => {
    await loginDemo(page, LEAD);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    for (const path of ['/feed', '/recognition', '/surveys']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('feed-post').or(page.getByTestId('leaderboard')).or(page.getByTestId('my-surveys')).first()).toBeVisible();
      await axeClean(page);
    }
    await page.goto('/feed');
    await page.getByTestId('feed-post').first().getByTestId('toggle-comments').click();
    await axeClean(page);
  });

  test('/engagement hub tabs, the survey builder and survey results (admin)', async ({ page }) => {
    await loginDemo(page, ADMIN);
    await page.goto('/engagement');
    await expect(page.getByTestId('engagement-overview')).toBeVisible();
    await expect(page.getByTestId('kpi-recognitions')).toBeVisible();
    await axeClean(page);
    await page.getByTestId('hub-tab-surveys').click();
    await expect(page.getByTestId('survey-admin-list')).toBeVisible();
    await axeClean(page);
    await page.getByTestId('hub-tab-categories').click();
    await expect(page.getByTestId('category-list')).toBeVisible();
    await axeClean(page);
    await page.getByTestId('hub-tab-surveys').click();
    await page.getByTestId('new-survey-button').click();
    await expect(page.getByTestId('survey-builder')).toBeVisible();
    await axeClean(page);
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await page.getByTestId('survey-results-link').first().click();
    await expect(page.getByTestId('results-title')).toBeVisible();
    await axeClean(page);
  });
});
