/**
 * Proves engagement & culture (step 10.1) end to end over real HTTP + the real database — see
 * docs/conventions/engagement-culture.md: recognition (public/private, notification, feed,
 * leaderboard, points), surveys (team/department targeting, responses, aggregated results, response
 * rate) and — the key privacy test — that an ANONYMOUS survey's responses are genuinely unlinkable to
 * the respondent (verified against the raw tables with the OWNER client, not just the API), the feed
 * (visibility scopes, reactions, comments, moderation, derived celebrations), RBAC and cross-tenant
 * isolation.
 *
 * A JWT is minted directly, same rationale every other e2e suite in this codebase documents.
 *
 * Requires local infra up and migrations applied (and the notification templates seeded):
 *   docker compose up -d postgres redis minio
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { prisma, seedCountryPacks, seedNotificationTemplates, seedSystemRolesAndPermissions, SYSTEM_ROLES, withTenantContext } from '@hrm/db';
import { ANONYMITY_MIN_RESPONSES } from '@hrm/shared';
import { AppModule } from '../src/app.module';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_A = 'engage-test-a';
const SLUG_B = 'engage-test-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const hostFor = (slug: string) => `${slug}.${BASE_DOMAIN}`;

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result as T;
    if (Date.now() > deadline) throw new Error('waitFor: timed out.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('engagement & culture (e2e)', () => {
  let app: INestApplication;
  let tenantAId: string;
  let tenantBId: string;
  let branchUs: string;
  let branchQa: string;
  let deptEng: string;
  let deptSales: string;

  interface Person {
    userId: string;
    employeeId: string | null;
    token: string;
    name: string;
  }
  let admin: Person; // TENANT_ADMIN, NO employee profile
  let hr: Person; // HR_MANAGER
  let manager: Person; // MANAGER, manages alice + bob
  let alice: Person; // EMPLOYEE, Engineering, US
  let bob: Person; // EMPLOYEE, Engineering, US
  let carol: Person; // EMPLOYEE, Sales, US (not on manager's team)
  let dina: Person; // EMPLOYEE, QA (Doha) branch
  let eve: Person; // EMPLOYEE, Sales, US — also manager's report
  let restricted: Person; // EMPLOYEE restricted to the QA branch (UserBranch)
  let adminB: Person;

  const api = (token: string, slug = SLUG_A) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: unknown = {}) => request(app.getHttpServer()).post(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`).send(body as object),
    put: (path: string, body: unknown) => request(app.getHttpServer()).put(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`).send(body as object),
    del: (path: string) => request(app.getHttpServer()).delete(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
  });

  async function roleId(tenantId: string, name: string) {
    return (await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } })).id;
  }

  let counter = 0;
  async function makePerson(tenantId: string, slug: string, roleName: string, first: string, opts: { branchId?: string; departmentId?: string; managerEmployeeId?: string; noEmployee?: boolean } = {}): Promise<Person> {
    counter += 1;
    const user = await prisma.user.create({ data: { tenantId, email: `${first.toLowerCase()}@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: await roleId(tenantId, roleName) } });
    let employeeId: string | null = null;
    if (!opts.noEmployee) {
      const employee = await prisma.employee.create({
        data: {
          tenantId, userId: user.id, branchId: opts.branchId!, departmentId: opts.departmentId, managerId: opts.managerEmployeeId,
          employeeCode: `ENG-${slug}-${counter}`, firstName: first, lastName: 'Tester', employmentType: 'FULL_TIME', joinDate: new Date('2024-01-01'), status: 'ACTIVE',
        },
      });
      employeeId = employee.id;
    }
    return { userId: user.id, employeeId, token: jwt.sign({ sub: user.id, tenantId }), name: `${first} Tester` };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await seedCountryPacks(prisma);
    await seedNotificationTemplates(prisma);
    const a = await prisma.tenant.create({ data: { name: 'Engage A', slug: SLUG_A, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    const b = await prisma.tenant.create({ data: { name: 'Engage B', slug: SLUG_B, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    tenantAId = a.id;
    tenantBId = b.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    branchUs = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Engage US', countryCode: 'US', timezone: 'America/New_York' } })).id;
    branchQa = (await prisma.branch.create({ data: { tenantId: tenantAId, name: 'Engage Doha', countryCode: 'QA', timezone: 'Asia/Qatar' } })).id;
    deptEng = (await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Engineering' } })).id;
    deptSales = (await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Sales' } })).id;
    const branchB = await prisma.branch.create({ data: { tenantId: tenantBId, name: 'B HQ', countryCode: 'US', timezone: 'America/New_York' } });

    admin = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.TENANT_ADMIN, 'Admin', { noEmployee: true });
    hr = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.HR_MANAGER, 'Hannah', { branchId: branchUs, departmentId: deptSales });
    manager = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.MANAGER, 'Mona', { branchId: branchUs, departmentId: deptEng });
    alice = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Alice', { branchId: branchUs, departmentId: deptEng, managerEmployeeId: manager.employeeId! });
    bob = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Bob', { branchId: branchUs, departmentId: deptEng, managerEmployeeId: manager.employeeId! });
    eve = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Eve', { branchId: branchUs, departmentId: deptSales, managerEmployeeId: manager.employeeId! });
    carol = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Carol', { branchId: branchUs, departmentId: deptSales });
    dina = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Dina', { branchId: branchQa });
    restricted = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Rae', { branchId: branchQa });
    await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: restricted.userId, branchId: branchQa } });
    adminB = await makePerson(tenantBId, SLUG_B, SYSTEM_ROLES.TENANT_ADMIN, 'AdminB', { branchId: branchB.id });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await app.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe('recognition', () => {
    let teamworkId: string;
    let publicRecognitionId: string;
    let privateRecognitionId: string;

    it('an admin configures tenant categories (data, with points); an employee cannot', async () => {
      const created = await api(admin.token).post('/recognition/categories', { name: 'Teamwork', description: 'Helping the team', points: 5 });
      expect(created.status).toBe(201);
      teamworkId = created.body.id;
      expect(created.body.points).toBe(5);
      expect((await api(admin.token).post('/recognition/categories', { name: 'Teamwork', points: 1 })).status).toBe(409);
      expect((await api(alice.token).post('/recognition/categories', { name: 'Nope', points: 1 })).status).toBe(403);

      const inactive = await api(admin.token).post('/recognition/categories', { name: 'Retired value', points: 1, isActive: false });
      expect(inactive.status).toBe(201);
      const list = await api(alice.token).get('/recognition/categories');
      expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Teamwork']); // inactive hidden from employees
      const adminList = await api(admin.token).get('/recognition/categories?all=true');
      expect(adminList.body).toHaveLength(2);
    });

    it('gives PUBLIC recognition to two people: recipients are notified via the 0.8 hub, it shows in the feed, the leaderboard and the points tally', async () => {
      const res = await api(alice.token).post('/recognition', { recipientEmployeeIds: [bob.employeeId, eve.employeeId], categoryId: teamworkId, message: 'Great teamwork on the launch!', visibility: 'PUBLIC' });
      expect(res.status).toBe(201);
      publicRecognitionId = res.body.id;
      expect(res.body.recipients).toHaveLength(2);
      expect(res.body.giver.name).toBe(alice.name);

      // Notified through the hub (async, BullMQ).
      const note = await waitFor(async () => {
        const list = await api(bob.token).get('/notifications');
        return (list.body as { eventType: string; delivery: { renderedBody: string | null } }[]).find((n) => n.eventType === 'engagement.recognition_received' && !!n.delivery.renderedBody);
      });
      expect(note.delivery.renderedBody).toContain('Alice Tester');
      expect(note.delivery.renderedBody).toContain('Teamwork');

      // In the feed, with its recognition payload.
      const feed = await api(carol.token).get('/feed');
      const post = feed.body.posts.find((p: { recognition: { id: string } | null }) => p.recognition?.id === publicRecognitionId);
      expect(post).toBeDefined();
      expect(post.type).toBe('RECOGNITION');
      expect(post.recognition.category.name).toBe('Teamwork');

      // Leaderboard + points.
      const board = await api(carol.token).get('/recognition/leaderboard');
      expect(board.status).toBe(200);
      const bobRow = board.body.entries.find((e: { employeeId: string }) => e.employeeId === bob.employeeId);
      expect(bobRow).toMatchObject({ points: 5, count: 1 });
      const mine = await api(bob.token).get(`/recognition/profile/${bob.employeeId}`);
      expect(mine.body).toMatchObject({ isSelf: true, totalPoints: 5, receivedCount: 1 });
      expect(mine.body.byCategory[0]).toMatchObject({ name: 'Teamwork', count: 1 });
      expect((await api(bob.token).get('/recognition/received')).body.map((r: { id: string }) => r.id)).toContain(publicRecognitionId);
      expect((await api(alice.token).get('/recognition/given')).body.map((r: { id: string }) => r.id)).toContain(publicRecognitionId);
    });

    it('PRIVATE recognition reaches only the recipient: no feed post, not on the leaderboard, invisible on others\' profile views — but counted in the recipient\'s own tally', async () => {
      const res = await api(carol.token).post('/recognition', { recipientEmployeeIds: [alice.employeeId], categoryId: teamworkId, message: 'Thanks for the quiet help.', visibility: 'PRIVATE' });
      expect(res.status).toBe(201);
      privateRecognitionId = res.body.id;

      await waitFor(async () => (await api(alice.token).get('/notifications')).body.some((n: { eventType: string }) => n.eventType === 'engagement.recognition_received'));
      expect((await api(alice.token).get('/recognition/received')).body.map((r: { id: string }) => r.id)).toContain(privateRecognitionId);

      const feed = await api(bob.token).get('/feed?limit=50');
      expect(feed.body.posts.some((p: { recognition: { id: string } | null }) => p.recognition?.id === privateRecognitionId)).toBe(false);
      expect(JSON.stringify(feed.body)).not.toContain('quiet help');

      const board = await api(bob.token).get('/recognition/leaderboard');
      expect(board.body.entries.find((e: { employeeId: string }) => e.employeeId === alice.employeeId)).toBeUndefined();

      const others = await api(bob.token).get(`/recognition/profile/${alice.employeeId}`);
      expect(others.body.isSelf).toBe(false);
      expect(others.body.totalPoints).toBe(0);
      expect(others.body.recent).toHaveLength(0);
      const own = await api(alice.token).get(`/recognition/profile/${alice.employeeId}`);
      expect(own.body.totalPoints).toBe(5);
    });

    it('validates: no self-recognition, no inactive category, an admin without an employee profile cannot give, out-of-branch-scope recipients are a 404', async () => {
      const inactive = (await api(admin.token).get('/recognition/categories?all=true')).body.find((c: { isActive: boolean }) => !c.isActive);
      expect((await api(alice.token).post('/recognition', { recipientEmployeeIds: [alice.employeeId], categoryId: teamworkId, message: 'me' })).status).toBe(400);
      expect((await api(alice.token).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: inactive.id, message: 'x' })).status).toBe(400);
      expect((await api(admin.token).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: teamworkId, message: 'x' })).status).toBe(403);
      expect((await api(alice.token).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: teamworkId, message: '' })).status).toBe(400);
      // `restricted` is scoped to the Doha branch — Bob (US) is outside it.
      expect((await api(restricted.token).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: teamworkId, message: 'x' })).status).toBe(404);
      expect((await api(restricted.token).post('/recognition', { recipientEmployeeIds: [dina.employeeId], categoryId: teamworkId, message: 'ok' })).status).toBe(201);
    });

    it('the leaderboard respects branch scope', async () => {
      const board = await api(restricted.token).get('/recognition/leaderboard');
      const ids = board.body.entries.map((e: { employeeId: string }) => e.employeeId);
      expect(ids).toContain(dina.employeeId);
      expect(ids).not.toContain(bob.employeeId);
      expect((await api(restricted.token).get(`/recognition/profile/${bob.employeeId}`)).status).toBe(404);
    });

    it('moderating a recognition\'s feed post reverses its points and hides it', async () => {
      const feed = await api(admin.token).get('/feed?limit=50');
      const post = feed.body.posts.find((p: { recognition: { id: string } | null }) => p.recognition?.id === publicRecognitionId);
      expect((await api(alice.token).del(`/feed/posts/${post.id}`)).status).toBe(403);
      const removed = await api(admin.token).del(`/feed/posts/${post.id}?reason=off-topic`);
      expect(removed.status).toBe(200);

      expect((await api(carol.token).get('/feed?limit=50')).body.posts.some((p: { id: string }) => p.id === post.id)).toBe(false);
      const profile = await api(bob.token).get(`/recognition/profile/${bob.employeeId}`);
      expect(profile.body).toMatchObject({ totalPoints: 0, receivedCount: 0 });
      const board = await api(carol.token).get('/recognition/leaderboard');
      expect(board.body.entries.find((e: { employeeId: string }) => e.employeeId === bob.employeeId)).toBeUndefined();

      // The removal is audited (0.9), with the reason attached to the post.
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, entityType: 'FeedPost', action: 'DELETE', entityId: post.id } });
      expect(audit?.actorUserId).toBe(admin.userId);
      expect((await prisma.feedPost.findUniqueOrThrow({ where: { id: post.id } })).removalReason).toBe('off-topic');
    });

    it('giving recognition is audited', async () => {
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, entityType: 'Recognition', action: 'CREATE', entityId: publicRecognitionId } });
      expect(audit?.actorUserId).toBe(alice.userId);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('surveys', () => {
    let teamSurveyId: string;
    let ratingQ: string;
    let choiceQ: string;
    let multiQ: string;
    let textQ: string;

    const questions = [
      { type: 'RATING', prompt: 'How satisfied are you?', scaleMin: 1, scaleMax: 5 },
      { type: 'SINGLE_CHOICE', prompt: 'Best perk?', options: [{ id: 'remote', label: 'Remote work' }, { id: 'gym', label: 'Gym' }] },
      { type: 'MULTI_CHOICE', prompt: 'Which tools?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], required: false },
      { type: 'TEXT', prompt: 'Anything else?', required: false },
    ];

    it('an admin creates a DRAFT survey for a TEAM (a manager\'s reporting chain); validation rejects bad definitions', async () => {
      const bad = await api(admin.token).post('/surveys', { title: 'Bad', questions: [{ type: 'RATING', prompt: 'x' }] });
      expect(bad.status).toBe(400);
      const badAudience = await api(admin.token).post('/surveys', { title: 'Bad', audienceType: 'TEAM', audienceIds: [], questions });
      expect(badAudience.status).toBe(400);

      const created = await api(admin.token).post('/surveys', {
        title: 'Team pulse', description: 'Quarterly pulse', anonymous: false, audienceType: 'TEAM', audienceIds: [manager.employeeId], questions,
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('DRAFT');
      teamSurveyId = created.body.id;
      [ratingQ, choiceQ, multiQ, textQ] = created.body.questions.map((q: { id: string }) => q.id);

      // A draft is editable (full replace) ...
      const edited = await api(admin.token).put(`/surveys/${teamSurveyId}`, { title: 'Team pulse Q3', anonymous: false, audienceType: 'TEAM', audienceIds: [manager.employeeId], questions });
      expect(edited.status).toBe(200);
      expect(edited.body.title).toBe('Team pulse Q3');
      [ratingQ, choiceQ, multiQ, textQ] = edited.body.questions.map((q: { id: string }) => q.id);
      // ... and nobody is assigned until it is published.
      expect((await api(alice.token).get('/surveys/mine')).body).toHaveLength(0);
    });

    it('publishing assigns exactly the team, notifies them via the 0.8 hub, and freezes the survey', async () => {
      const published = await api(admin.token).post(`/surveys/${teamSurveyId}/publish`);
      expect(published.status).toBe(201);
      expect(published.body).toMatchObject({ status: 'OPEN', assignedCount: 3, responseCount: 0 }); // alice, bob, eve (not manager, not carol)

      for (const p of [alice, bob, eve]) {
        const mine = await api(p.token).get('/surveys/mine');
        expect(mine.body).toHaveLength(1);
        expect(mine.body[0]).toMatchObject({ surveyId: teamSurveyId, state: 'OPEN', status: 'PENDING', anonymous: false });
      }
      for (const p of [carol, manager, dina]) {
        expect((await api(p.token).get('/surveys/mine')).body).toHaveLength(0);
        expect((await api(p.token).get(`/surveys/mine/${teamSurveyId}`)).status).toBe(404);
        expect((await api(p.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [] })).status).toBe(404);
      }

      const note = await waitFor(async () => (await api(alice.token).get('/notifications')).body.find((n: { eventType: string; delivery: { renderedBody: string | null } }) => n.eventType === 'engagement.survey_assigned' && !!n.delivery.renderedBody));
      expect(note.delivery.renderedBody).toContain('Team pulse Q3');

      expect((await api(admin.token).put(`/surveys/${teamSurveyId}`, { title: 'x', questions })).status).toBe(409);
      expect((await api(admin.token).post(`/surveys/${teamSurveyId}/publish`)).status).toBe(409);
    });

    it('members answer; answers are validated; double-submit is refused; results + response rate aggregate', async () => {
      const taking = await api(alice.token).get(`/surveys/mine/${teamSurveyId}`);
      expect(taking.status).toBe(200);
      expect(taking.body.questions).toHaveLength(4);

      // Required question missing / out-of-range rating / unknown option -> 400.
      expect((await api(alice.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [{ questionId: choiceQ, optionIds: ['gym'] }] })).status).toBe(400);
      expect((await api(alice.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [{ questionId: ratingQ, ratingValue: 9 }, { questionId: choiceQ, optionIds: ['gym'] }] })).status).toBe(400);
      expect((await api(alice.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [{ questionId: ratingQ, ratingValue: 3 }, { questionId: choiceQ, optionIds: ['nope'] }] })).status).toBe(400);

      const submit = (p: Person, rating: number, perk: string, extra: object[] = []) =>
        api(p.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [{ questionId: ratingQ, ratingValue: rating }, { questionId: choiceQ, optionIds: [perk] }, ...extra] });

      expect((await submit(alice, 5, 'remote', [{ questionId: multiQ, optionIds: ['a', 'b'] }, { questionId: textQ, text: 'Love the team' }])).status).toBe(201);
      expect((await submit(bob, 3, 'gym', [{ questionId: multiQ, optionIds: ['a'] }])).status).toBe(201);
      expect((await submit(alice, 1, 'gym')).status).toBe(409); // already answered
      expect((await api(alice.token).get('/surveys/mine')).body[0]).toMatchObject({ status: 'SUBMITTED' });

      const results = await api(admin.token).get(`/surveys/${teamSurveyId}/results`);
      expect(results.status).toBe(200);
      expect(results.body.suppressed).toBe(false);
      expect(results.body.survey).toMatchObject({ assignedCount: 3, responseCount: 2, responseRate: 66.7 });
      const [r, c, m, t] = results.body.questions;
      expect(r.average).toBe(4);
      expect(r.distribution.find((d: { value: number }) => d.value === 5).count).toBe(1);
      expect(c.options.find((o: { id: string }) => o.id === 'remote')).toMatchObject({ count: 1, percent: 50 });
      expect(m.options.find((o: { id: string }) => o.id === 'a').count).toBe(2);
      expect(t.textAnswers).toEqual(['Love the team']);

      // Identified survey: the admin can see who has / hasn't answered.
      const respondents = await api(admin.token).get(`/surveys/${teamSurveyId}/respondents`);
      expect(respondents.body.filter((x: { status: string }) => x.status === 'SUBMITTED')).toHaveLength(2);
      expect(respondents.body.filter((x: { status: string }) => x.status === 'PENDING').map((x: { name: string }) => x.name)).toEqual([eve.name]);
    });

    it('a closed survey refuses answers; closing is audited; creation/publish are audited', async () => {
      expect((await api(admin.token).post(`/surveys/${teamSurveyId}/close`)).body.status).toBe('CLOSED');
      const late = await api(eve.token).post(`/surveys/${teamSurveyId}/responses`, { answers: [{ questionId: ratingQ, ratingValue: 4 }, { questionId: choiceQ, optionIds: ['gym'] }] });
      expect(late.status).toBe(409);
      expect((await api(eve.token).get('/surveys/mine')).body[0].state).toBe('CLOSED');

      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, entityType: 'Survey', entityId: teamSurveyId } });
      expect(audits.map((a) => a.action).sort()).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'UPDATE']); // create, edit, publish, close
      expect(audits.every((a) => a.actorUserId === admin.userId)).toBe(true);
    });

    it('DEPARTMENT and BRANCH audiences resolve correctly (a department includes its sub-departments)', async () => {
      const sub = await prisma.department.create({ data: { tenantId: tenantAId, branchId: branchUs, name: 'Platform', parentDepartmentId: deptEng } });
      const subEmp = await makePerson(tenantAId, SLUG_A, SYSTEM_ROLES.EMPLOYEE, 'Sub', { branchId: branchUs, departmentId: sub.id });

      const dept = await api(admin.token).post('/surveys', { title: 'Eng survey', audienceType: 'DEPARTMENT', audienceIds: [deptEng], questions: [questions[0]] });
      const pubDept = await api(admin.token).post(`/surveys/${dept.body.id}/publish`);
      expect(pubDept.body.assignedCount).toBe(4); // manager, alice, bob (Engineering) + Sub (sub-department)
      expect((await api(subEmp.token).get('/surveys/mine')).body).toHaveLength(1);
      expect((await api(carol.token).get('/surveys/mine')).body).toHaveLength(0);

      const branch = await api(admin.token).post('/surveys', { title: 'Doha survey', audienceType: 'BRANCH', audienceIds: [branchQa], questions: [questions[0]] });
      expect((await api(admin.token).post(`/surveys/${branch.body.id}/publish`)).body.assignedCount).toBe(2); // dina + rae
      const org = await api(admin.token).post('/surveys', { title: 'Org survey', audienceType: 'ORG', questions: [questions[0]] });
      expect(org.status).toBe(201);
      expect((await api(admin.token).post(`/surveys/${org.body.id}/publish`)).body.assignedCount).toBeGreaterThanOrEqual(8);
    });

    it('concurrent double-submit records exactly one response', async () => {
      const s = await api(admin.token).post('/surveys', { title: 'Race', audienceType: 'BRANCH', audienceIds: [branchQa], questions: [questions[0]] });
      await api(admin.token).post(`/surveys/${s.body.id}/publish`);
      const q = s.body.questions[0].id;
      const body = { answers: [{ questionId: q, ratingValue: 4 }] };
      const results = await Promise.all([api(dina.token).post(`/surveys/${s.body.id}/responses`, body), api(dina.token).post(`/surveys/${s.body.id}/responses`, body), api(dina.token).post(`/surveys/${s.body.id}/responses`, body)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await prisma.surveyResponse.count({ where: { surveyId: s.body.id } })).toBe(1);
      expect((await prisma.survey.findUniqueOrThrow({ where: { id: s.body.id } })).responseCount).toBe(1);
      expect((await prisma.surveyTally.findFirstOrThrow({ where: { surveyId: s.body.id, bucket: '4' } })).count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ANONYMOUS surveys — the privacy guarantee', () => {
    const MARKER = 'ZEBRA-CONFIDENTIAL-FEEDBACK';
    let surveyId: string;
    let ratingQ: string;
    let textQ: string;
    const respondents: Person[] = [];

    it('records responses but stores NOTHING that links a response to a respondent', async () => {
      respondents.push(alice, bob, eve);
      const created = await api(admin.token).post('/surveys', {
        title: 'Anonymous culture check', anonymous: true, audienceType: 'TEAM', audienceIds: [manager.employeeId],
        questions: [{ type: 'RATING', prompt: 'Rate management', scaleMin: 1, scaleMax: 5 }, { type: 'TEXT', prompt: 'Candid feedback', required: false }],
      });
      surveyId = created.body.id;
      [ratingQ, textQ] = created.body.questions.map((q: { id: string }) => q.id);
      expect((await api(admin.token).post(`/surveys/${surveyId}/publish`)).body.assignedCount).toBe(3);

      // The survey tells the taker it is anonymous.
      expect((await api(alice.token).get(`/surveys/mine/${surveyId}`)).body.anonymous).toBe(true);

      // Two responses first (below the anonymity threshold).
      const ans = (rating: number, text?: string) => ({ answers: [{ questionId: ratingQ, ratingValue: rating }, ...(text ? [{ questionId: textQ, text }] : [])] });
      expect((await api(alice.token).post(`/surveys/${surveyId}/responses`, ans(2, `${MARKER} from alice`))).status).toBe(201);
      expect((await api(bob.token).post(`/surveys/${surveyId}/responses`, ans(4))).status).toBe(201);

      // ---- THE PROOF, against the raw tables with the OWNER client (no API in the way) ----
      const userIds = respondents.map((p) => p.userId);
      const employeeIds = respondents.map((p) => p.employeeId!);
      const emails = respondents.map((p) => `${p.name.split(' ')[0].toLowerCase()}@${SLUG_A}.test`);

      const responses = await prisma.surveyResponse.findMany({ where: { surveyId } });
      expect(responses).toHaveLength(2);
      for (const r of responses) {
        expect(r.respondentUserId).toBeNull();
        // `submittedOn` is a DATE column: no time-of-day exists to correlate with anything.
        expect(r.submittedOn.getUTCHours() + r.submittedOn.getUTCMinutes() + r.submittedOn.getUTCSeconds()).toBe(0);
      }
      const answers = await prisma.surveyAnswer.findMany({ where: { surveyId } });
      const tallies = await prisma.surveyTally.findMany({ where: { surveyId } });
      const assignments = await prisma.surveyAssignment.findMany({ where: { surveyId } });
      const blob = JSON.stringify({ responses, answers, tallies });
      for (const identity of [...userIds, ...employeeIds, ...emails, ...respondents.map((p) => p.name)]) {
        expect(blob).not.toContain(identity); // not one identifier anywhere in the response-side tables
      }
      // The ONLY place who-has-answered lives is the assignment: status + a DATE, no response id, no timestamp.
      expect(assignments.filter((a) => a.status === 'SUBMITTED')).toHaveLength(2);
      for (const a of assignments) expect(Object.keys(a).sort()).toEqual(['createdAt', 'id', 'status', 'submittedOn', 'surveyId', 'tenantId', 'userId']);
      // No column of survey_responses / survey_answers can hold a user id at all, other than the NULL one.
      const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('survey_responses','survey_answers','survey_tallies') AND (column_name LIKE '%user%' OR column_name LIKE '%employee%')`;
      expect(cols).toEqual([{ table_name: 'survey_responses', column_name: 'respondent_user_id' }]);

      // The audit trail holds no row tying a respondent to this survey or to what they wrote.
      const audit = await prisma.auditLog.findMany({ where: { tenantId: tenantAId, actorUserId: { in: userIds } } });
      expect(audit.filter((a) => a.entityId === surveyId || a.entityType.startsWith('Survey'))).toHaveLength(0);
      expect(JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: tenantAId } }))).not.toContain(MARKER);
      // ... and the one outbound domain event carries no respondent either (none is emitted at all).
      expect(JSON.stringify(await prisma.notification.findMany({ where: { tenantId: tenantAId, eventType: { startsWith: 'engagement.survey_' } } }))).not.toContain(MARKER);
    });

    it('withholds aggregates below the anonymity threshold, then shows them — with no identity anywhere in the results', async () => {
      const early = await api(admin.token).get(`/surveys/${surveyId}/results`);
      expect(early.body.suppressed).toBe(true);
      expect(early.body.anonymityThreshold).toBe(ANONYMITY_MIN_RESPONSES);
      expect(early.body.survey.responseCount).toBe(2); // the response rate is still visible
      expect(JSON.stringify(early.body)).not.toContain(MARKER);
      expect(early.body.questions[0].average).toBeUndefined();

      expect((await api(eve.token).post(`/surveys/${surveyId}/responses`, { answers: [{ questionId: ratingQ, ratingValue: 3 }] })).status).toBe(201);
      const res = await api(admin.token).get(`/surveys/${surveyId}/results`);
      expect(res.body.suppressed).toBe(false);
      expect(res.body.questions[0].average).toBe(3);
      expect(res.body.questions[1].textAnswers).toEqual([`${MARKER} from alice`]); // the text, never who wrote it

      const body = JSON.stringify(res.body);
      for (const p of respondents) {
        expect(body).not.toContain(p.userId);
        expect(body).not.toContain(p.employeeId!);
        expect(body).not.toContain(p.name);
      }
      // The admin cannot even ask who has/hasn't answered (it would re-identify by elimination).
      expect((await api(admin.token).get(`/surveys/${surveyId}/respondents`)).status).toBe(403);
      // And a non-admin cannot read results at all.
      expect((await api(alice.token).get(`/surveys/${surveyId}/results`)).status).toBe(403);
    });

    it('the application DB role cannot UPDATE or DELETE a stored response (no way to re-attribute it later)', async () => {
      const row = await prisma.surveyResponse.findFirstOrThrow({ where: { surveyId } });
      await expect(
        withTenantContext(tenantAId, (tx) => tx.surveyResponse.update({ where: { id: row.id }, data: { respondentUserId: alice.userId } })),
      ).rejects.toThrow(/permission denied/i);
      await expect(withTenantContext(tenantAId, (tx) => tx.surveyResponse.delete({ where: { id: row.id } }))).rejects.toThrow(/permission denied/i);
      await expect(withTenantContext(tenantAId, (tx) => tx.surveyAnswer.deleteMany({ where: { surveyId } }))).rejects.toThrow(/permission denied/i);
      expect((await prisma.surveyResponse.findUniqueOrThrow({ where: { id: row.id } })).respondentUserId).toBeNull();
    });

    it('contrast: a NON-anonymous survey does retain the link (so the guarantee above is real, not an artifact of the test)', async () => {
      const s = await api(admin.token).post('/surveys', { title: 'Identified', anonymous: false, audienceType: 'BRANCH', audienceIds: [branchQa], questions: [{ type: 'RATING', prompt: 'r', scaleMin: 1, scaleMax: 5 }] });
      await api(admin.token).post(`/surveys/${s.body.id}/publish`);
      await api(dina.token).post(`/surveys/${s.body.id}/responses`, { answers: [{ questionId: s.body.questions[0].id, ratingValue: 5 }] });
      expect((await prisma.surveyResponse.findFirstOrThrow({ where: { surveyId: s.body.id } })).respondentUserId).toBe(dina.userId);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('feed', () => {
    let orgPostId: string;
    let deptPostId: string;
    let commentId: string;

    it('admins post announcements to ORG and to a department (team feed); visibility follows scope', async () => {
      const org = await api(admin.token).post('/feed/posts', { type: 'ANNOUNCEMENT', title: 'Town hall', body: 'Friday at 3pm', scopeType: 'ORG', pinned: true });
      expect(org.status).toBe(201);
      orgPostId = org.body.id;
      const dept = await api(admin.token).post('/feed/posts', { type: 'ANNOUNCEMENT', body: 'Engineering offsite', scopeType: 'DEPARTMENT', scopeId: deptEng });
      deptPostId = dept.body.id;

      const aliceFeed = (await api(alice.token).get('/feed')).body.posts.map((p: { id: string }) => p.id); // Engineering
      expect(aliceFeed).toEqual(expect.arrayContaining([orgPostId, deptPostId]));
      const carolFeed = (await api(carol.token).get('/feed')).body.posts.map((p: { id: string }) => p.id); // Sales
      expect(carolFeed).toContain(orgPostId);
      expect(carolFeed).not.toContain(deptPostId);
      const aliceTeamOnly = (await api(alice.token).get('/feed?scope=TEAM')).body.posts.map((p: { id: string }) => p.id);
      expect(aliceTeamOnly).toEqual([deptPostId]);
      // Pinned leads.
      expect((await api(carol.token).get('/feed')).body.posts[0].id).toBe(orgPostId);
      // A user outside the scope cannot react to / read comments of it (404, never a hint).
      expect((await api(carol.token).post(`/feed/posts/${deptPostId}/reactions`, { type: 'LIKE' })).status).toBe(404);
      expect((await api(carol.token).get(`/feed/posts/${deptPostId}/comments`)).status).toBe(404);
      // An employee cannot post announcements.
      expect((await api(alice.token).post('/feed/posts', { body: 'hi', scopeType: 'ORG' })).status).toBe(403);
      // Admin sees every scope (needed to moderate).
      expect((await api(admin.token).get('/feed')).body.posts.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([orgPostId, deptPostId]));
    });

    it('employees react (one per person, switchable, removable) and comment', async () => {
      expect((await api(bob.token).post(`/feed/posts/${orgPostId}/reactions`, { type: 'LIKE' })).body).toMatchObject({ LIKE: 1, CELEBRATE: 0, mine: 'LIKE' });
      expect((await api(alice.token).post(`/feed/posts/${orgPostId}/reactions`, { type: 'CELEBRATE' })).body).toMatchObject({ LIKE: 1, CELEBRATE: 1, mine: 'CELEBRATE' });
      expect((await api(bob.token).post(`/feed/posts/${orgPostId}/reactions`, { type: 'CELEBRATE' })).body).toMatchObject({ LIKE: 0, CELEBRATE: 2 }); // switched, not doubled
      expect((await api(bob.token).del(`/feed/posts/${orgPostId}/reactions`)).body).toMatchObject({ CELEBRATE: 1, mine: null });

      const comment = await api(carol.token).post(`/feed/posts/${orgPostId}/comments`, { body: 'See you there!' });
      expect(comment.status).toBe(201);
      commentId = comment.body.id;
      expect((await api(carol.token).post(`/feed/posts/${orgPostId}/comments`, { body: '' })).status).toBe(400);

      const comments = await api(alice.token).get(`/feed/posts/${orgPostId}/comments`);
      expect(comments.body).toHaveLength(1);
      expect(comments.body[0]).toMatchObject({ body: 'See you there!', mine: false });
      const post = (await api(alice.token).get('/feed')).body.posts.find((p: { id: string }) => p.id === orgPostId);
      expect(post).toMatchObject({ commentCount: 1, reactions: { LIKE: 0, CELEBRATE: 1, mine: 'CELEBRATE' } });
    });

    it('moderation: only engagement.manage can remove a comment or post; removed content disappears and is audited', async () => {
      expect((await api(carol.token).del(`/feed/comments/${commentId}`)).status).toBe(403); // even the author goes through moderation
      expect((await api(admin.token).del(`/feed/comments/${commentId}`)).status).toBe(200);
      expect((await api(alice.token).get(`/feed/posts/${orgPostId}/comments`)).body).toHaveLength(0);
      expect((await api(alice.token).get('/feed')).body.posts.find((p: { id: string }) => p.id === orgPostId).commentCount).toBe(0);

      expect((await api(hr.token).del(`/feed/posts/${deptPostId}`)).status).toBe(200); // HR_MANAGER holds engagement.manage
      expect((await api(alice.token).get('/feed')).body.posts.map((p: { id: string }) => p.id)).not.toContain(deptPostId);
      expect((await api(alice.token).post(`/feed/posts/${deptPostId}/comments`, { body: 'late' })).status).toBe(404);
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId, entityType: 'FeedComment', action: 'DELETE', entityId: commentId } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId, entityType: 'FeedPost', action: 'DELETE', entityId: deptPostId } })).toBe(1);
    });

    it('derives celebrations from employee data (birthday, work anniversary, new joiner), idempotently', async () => {
      await prisma.employee.update({ where: { id: alice.employeeId! }, data: { dateOfBirth: new Date('1990-06-15'), joinDate: new Date('2023-06-15') } });
      await prisma.employee.update({ where: { id: bob.employeeId! }, data: { joinDate: new Date('2026-06-12') } });

      const first = await api(admin.token).post('/feed/celebrations/generate?date=2026-06-15');
      expect(first.body.created).toBe(3); // alice birthday + alice 3-year anniversary + bob new joiner
      expect((await api(admin.token).post('/feed/celebrations/generate?date=2026-06-15')).body.created).toBe(0); // idempotent
      expect((await api(alice.token).post('/feed/celebrations/generate')).status).toBe(403);

      const posts = (await api(carol.token).get('/feed?limit=50')).body.posts.filter((p: { type: string }) => p.type === 'CELEBRATION');
      const kinds = posts.map((p: { celebration: { kind: string } }) => p.celebration.kind).sort();
      expect(kinds).toEqual(['BIRTHDAY', 'NEW_JOINER', 'WORK_ANNIVERSARY']);
      const anniversary = posts.find((p: { celebration: { kind: string } }) => p.celebration.kind === 'WORK_ANNIVERSARY');
      expect(anniversary.celebration.meta).toEqual({ years: 3 });
      expect(anniversary.celebration.subject.name).toBe(alice.name);
      // The birthday post never exposes the birth YEAR / age.
      expect(JSON.stringify(posts)).not.toContain('1990');
      // People can react to a celebration.
      expect((await api(carol.token).post(`/feed/posts/${anniversary.id}/reactions`, { type: 'CELEBRATE' })).status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('RBAC', () => {
    it('engagement.manage gates survey authoring/results, categories, announcements, moderation and the overview; a normal employee participates but cannot manage', async () => {
      const surveyId = (await api(admin.token).post('/surveys', { title: 'RBAC', audienceType: 'ORG', questions: [{ type: 'TEXT', prompt: 'x' }] })).body.id;
      for (const call of [
        () => api(alice.token).get('/surveys'),
        () => api(alice.token).post('/surveys', { title: 'x', questions: [{ type: 'TEXT', prompt: 'x' }] }),
        () => api(alice.token).post(`/surveys/${surveyId}/publish`),
        () => api(alice.token).post(`/surveys/${surveyId}/close`),
        () => api(alice.token).get(`/surveys/${surveyId}`),
        () => api(alice.token).get(`/surveys/${surveyId}/results`),
        () => api(alice.token).post('/feed/posts', { body: 'x', scopeType: 'ORG' }),
        () => api(alice.token).get('/engagement/overview'),
        () => api(alice.token).post('/recognition/categories', { name: 'x', points: 1 }),
      ]) {
        expect((await call()).status).toBe(403);
      }
      // A manager-tier employee without engagement.manage is also refused.
      expect((await api(manager.token).get('/surveys')).status).toBe(403);
      // Participation works for a plain EMPLOYEE.
      const cat = (await api(alice.token).get('/recognition/categories')).body[0].id;
      expect((await api(alice.token).post('/recognition', { recipientEmployeeIds: [carol.employeeId], categoryId: cat, message: 'ty' })).status).toBe(201);
      expect((await api(alice.token).get('/feed')).status).toBe(200);
    });

    it('recognition.give is a real permission (giving/reacting/commenting need it; reading the feed and surveys does not)', async () => {
      // A custom role holding everything an employee has EXCEPT recognition.give (a brand-new role, so the
      // 5.1 permission cache has nothing stale for it).
      const role = await prisma.role.create({ data: { tenantId: tenantAId, name: 'NO_GIVE', isSystem: false } });
      const employeeRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
      const links = await prisma.rolePermission.findMany({ where: { roleId: employeeRole.id }, include: { permission: true } });
      for (const l of links.filter((x) => x.permission.key !== 'recognition.give')) {
        await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: role.id, permissionId: l.permissionId } });
      }
      const user = await prisma.user.create({ data: { tenantId: tenantAId, email: `nogive@${SLUG_A}.test`, hashedPassword: 'unused', status: 'ACTIVE' } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: user.id, roleId: role.id } });
      await prisma.employee.create({ data: { tenantId: tenantAId, userId: user.id, branchId: branchUs, employeeCode: 'ENG-NOGIVE', firstName: 'Nogive', lastName: 'Tester', employmentType: 'FULL_TIME', joinDate: new Date('2024-01-01'), status: 'ACTIVE' } });
      const token = jwt.sign({ sub: user.id, tenantId: tenantAId });

      const cat = (await api(token).get('/recognition/categories')).body[0].id;
      expect((await api(token).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: cat, message: 'x' })).status).toBe(403);
      const feed = await api(token).get('/feed');
      expect(feed.status).toBe(200);
      expect((await api(token).post(`/feed/posts/${feed.body.posts[0].id}/reactions`, { type: 'LIKE' })).status).toBe(403);
      expect((await api(token).post(`/feed/posts/${feed.body.posts[0].id}/comments`, { body: 'x' })).status).toBe(403);
      expect((await api(token).get('/surveys/mine')).status).toBe(200);
    });

    it('the admin overview reports recognition, survey and feed activity', async () => {
      const overview = await api(admin.token).get('/engagement/overview');
      expect(overview.status).toBe(200);
      expect(overview.body.recognition.received).toBeGreaterThan(0);
      expect(overview.body.recognition.uniqueGivers).toBeGreaterThan(0);
      expect(overview.body.recognition.topCategories[0].name).toBe('Teamwork');
      expect(overview.body.surveys.open).toBeGreaterThan(0);
      expect(overview.body.surveys.closed).toBeGreaterThan(0);
      expect(overview.body.feed.posts).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('another tenant sees none of this tenant\'s surveys, feed, categories or recognition, and its token is rejected on this tenant\'s host', async () => {
      const surveyId = (await prisma.survey.findFirstOrThrow({ where: { tenantId: tenantAId, anonymous: true } })).id;
      expect((await api(adminB.token, SLUG_B).get(`/surveys/${surveyId}`)).status).toBe(404);
      expect((await api(adminB.token, SLUG_B).get(`/surveys/${surveyId}/results`)).status).toBe(404);
      expect((await api(adminB.token, SLUG_B).get('/surveys')).body).toEqual([]);
      expect((await api(adminB.token, SLUG_B).get('/feed')).body.posts).toEqual([]);
      expect((await api(adminB.token, SLUG_B).get('/recognition/categories?all=true')).body).toEqual([]);
      expect((await api(adminB.token, SLUG_B).get('/recognition/leaderboard')).body.entries).toEqual([]);
      expect((await api(adminB.token, SLUG_B).get(`/recognition/profile/${bob.employeeId}`)).status).toBe(404);
      // Tenant B cannot recognize tenant A's people.
      const catB = (await api(adminB.token, SLUG_B).post('/recognition/categories', { name: 'B value', points: 1 })).body.id;
      const empB = (await api(adminB.token, SLUG_B).get(`/recognition/profile/${adminB.employeeId}`)).body.employee;
      expect(empB.id).toBe(adminB.employeeId);
      expect((await api(adminB.token, SLUG_B).post('/recognition', { recipientEmployeeIds: [bob.employeeId], categoryId: catB, message: 'x' })).status).toBe(404);
      // Token minted for B replayed against A's host.
      expect([401, 403]).toContain((await api(adminB.token, SLUG_A).get('/surveys')).status);
      // RLS holds at the database layer too: B's context cannot read A's survey rows even by id.
      const leaked = await withTenantContext(tenantBId, (tx) => tx.survey.findMany({ where: { id: surveyId } }));
      expect(leaked).toEqual([]);
    });
  });
});
