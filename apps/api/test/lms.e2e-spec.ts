/**
 * Proves the LMS module (step 3.2) end to end over real HTTP — see
 * docs/conventions/lms.md: course authoring (courses/content/a
 * config-as-data quiz) -> self-enrollment -> content progress -> a failed
 * quiz attempt keeps the course incomplete -> a passing attempt completes
 * it and issues a real certification with the pack's validity window;
 * admin assignment + the real 0.8 notification hub + the training
 * calendar; required-training compliance (the live, bounded drill-down
 * AND the real scheduled rollup job, never a live aggregate); the
 * certification-expiry reminder job's idempotency (no duplicate reminder
 * on re-run) and its EXPIRING -> EXPIRED transition; RBAC; cross-tenant
 * isolation via RLS.
 *
 * A JWT is minted directly, same rationale every other e2e suite in this
 * codebase documents for doing the same thing.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis minio
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'lms-test-tenant-a';
const TENANT_B_SLUG = 'lms-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('LMS — Learning & Development (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;

  let tokenAdminA: string;
  let tokenHrA: string;
  let tokenAdminB: string;

  function post(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).post(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }
  function get(path: string, token: string, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).get(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`);
  }
  function put(path: string, token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer()).put(path).set('Host', hostFor(host)).set('Authorization', `Bearer ${token}`).send(body);
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  let empCounter = 0;
  async function makeEmployeeWithUser(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
    empCounter += 1;
    const employeeRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const user = await makeUserWithRole(tenantId, employeeRole.id, `lms-emp-${empCounter}@lms-a.test`);
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        branchId,
        userId: user.id,
        employeeCode: `LMS-${empCounter}`,
        firstName: 'Fixture',
        lastName: `Employee${empCounter}`,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2026-01-01'),
        status: 'ACTIVE',
        ...overrides,
      },
    });
    return { user, employee, token: jwt.sign({ sub: user.id, tenantId }) };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'LMS Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'LMS Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchA = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'LMS A HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchAId = branchA.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const hrRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.HR_MANAGER } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@lms-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const hrA = await makeUserWithRole(tenantAId, hrRoleA.id, 'hr@lms-a.test');
    tokenHrA = jwt.sign({ sub: hrA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@lms-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('Course authoring: catalog, content, a config-as-data quiz', () => {
    it('a plain employee cannot author a course (lms.author is deny-by-default)', async () => {
      const { token } = await makeEmployeeWithUser(tenantAId, branchAId);
      await post('/lms/courses', token, { title: 'Should be rejected' }).expect(403);
    });

    it('a course cannot be published with zero content items', async () => {
      const category = await post('/lms/categories', tokenHrA, { code: 'COMPLIANCE', name: 'Compliance' }).expect(201);
      const course = await post('/lms/courses', tokenHrA, {
        categoryId: category.body.id,
        title: 'Workplace Safety',
        validityMonths: 12,
      }).expect(201);
      expect(course.body.status).toBe('DRAFT');

      await post(`/lms/courses/${course.body.id}/publish`, tokenHrA, {}).expect(409);
    });

    it('a DRAFT course is invisible to a plain employee catalog browse', async () => {
      const { token } = await makeEmployeeWithUser(tenantAId, branchAId);
      const draft = await post('/lms/courses', tokenHrA, { title: 'Not yet visible' }).expect(201);

      const catalog = await get('/lms/courses', token).expect(200);
      expect(catalog.body.some((c: { id: string }) => c.id === draft.body.id)).toBe(false);
      await get(`/lms/courses/${draft.body.id}`, token).expect(404);
    });
  });

  describe('Enrollment -> content progress -> a required quiz gates completion -> certification is issued', () => {
    let courseId: string;
    let itemAId: string;
    let itemBId: string;
    let enrollmentId: string;
    let learnerToken: string;

    beforeAll(async () => {
      const course = await post('/lms/courses', tokenHrA, { title: 'Data Privacy 101', isMandatory: true, validityMonths: 12 }).expect(201);
      courseId = course.body.id;

      const itemA = await post(`/lms/courses/${courseId}/content`, tokenHrA, {
        orderIndex: 0,
        type: 'VIDEO',
        title: 'Intro video',
        durationMinutes: 10,
      }).expect(201);
      itemAId = itemA.body.id;
      const itemB = await post(`/lms/courses/${courseId}/content`, tokenHrA, {
        orderIndex: 1,
        type: 'LINK',
        title: 'Policy reading',
        externalUrl: 'https://example.test/policy',
      }).expect(201);
      itemBId = itemB.body.id;

      await request(app.getHttpServer())
        .post(`/lms/courses/${courseId}/content/${itemAId}/file`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .attach('file', Buffer.from('a totally real training video'), 'intro.mp4')
        .expect(201);

      await put(`/lms/courses/${courseId}/quiz`, tokenHrA, { title: 'Data Privacy Quiz', passMarkPercent: 70 }).expect(200);
      await post(`/lms/courses/${courseId}/quiz/questions`, tokenHrA, {
        orderIndex: 0,
        questionText: 'PII stands for?',
        options: [
          { key: 'a', text: 'Personally Identifiable Information' },
          { key: 'b', text: 'Public Internet Index' },
        ],
        correctOptionKey: 'a',
      }).expect(201);
      await post(`/lms/courses/${courseId}/quiz/questions`, tokenHrA, {
        orderIndex: 1,
        questionText: 'GDPR applies to?',
        options: [
          { key: 'a', text: 'Only US companies' },
          { key: 'b', text: 'EU personal data processing' },
        ],
        correctOptionKey: 'b',
      }).expect(201);

      await post(`/lms/courses/${courseId}/publish`, tokenHrA, {}).expect(201);
    });

    it('the uploaded content file downloads back byte-for-byte', async () => {
      const downloaded = await request(app.getHttpServer())
        .get(`/lms/courses/${courseId}/content/${itemAId}/file`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((downloaded.body as Buffer).toString()).toBe('a totally real training video');
    });

    it('self-enrolls, and a duplicate active enrollment is rejected', async () => {
      const fixture = await makeEmployeeWithUser(tenantAId, branchAId);
      learnerToken = fixture.token;

      const enrollment = await post(`/lms/courses/${courseId}/enroll`, learnerToken, {}).expect(201);
      enrollmentId = enrollment.body.id;
      expect(enrollment.body.status).toBe('ENROLLED');
      expect(enrollment.body.source).toBe('SELF');

      await post(`/lms/courses/${courseId}/enroll`, learnerToken, {}).expect(409);
    });

    it('the quiz served for taking never includes the correct answer key', async () => {
      const quiz = await get(`/lms/courses/${courseId}/quiz`, learnerToken).expect(200);
      expect(quiz.body.questions).toHaveLength(2);
      for (const question of quiz.body.questions) {
        expect(question.correctOptionKey).toBeUndefined();
      }
    });

    it('completing every content item alone does NOT complete the course — the required quiz still gates it', async () => {
      await post(`/lms/enrollments/${enrollmentId}/content/${itemAId}/complete`, learnerToken, {}).expect(201);
      const midway = await get(`/lms/enrollments/${enrollmentId}`, learnerToken).expect(200);
      expect(midway.body.status).toBe('IN_PROGRESS');

      await post(`/lms/enrollments/${enrollmentId}/content/${itemBId}/complete`, learnerToken, {}).expect(201);
      const stillOpen = await get(`/lms/enrollments/${enrollmentId}`, learnerToken).expect(200);
      expect(stillOpen.body.status).toBe('IN_PROGRESS');
    });

    it('a failing quiz attempt keeps the enrollment open (no certification issued)', async () => {
      const quiz = await get(`/lms/courses/${courseId}/quiz`, learnerToken).expect(200);
      const questionIds: string[] = quiz.body.questions.map((q: { id: string }) => q.id);

      const attempt = await post(`/lms/enrollments/${enrollmentId}/quiz/attempts`, learnerToken, {
        answers: { [questionIds[0]]: 'b', [questionIds[1]]: 'a' },
      }).expect(201);
      expect(attempt.body.passed).toBe(false);
      expect(attempt.body.scorePercent).toBe(0);

      const stillOpen = await get(`/lms/enrollments/${enrollmentId}`, learnerToken).expect(200);
      expect(stillOpen.body.status).toBe('IN_PROGRESS');
      const myCerts = await get('/lms/certifications/me', learnerToken).expect(200);
      expect(myCerts.body).toEqual([]);
    });

    it('a passing quiz attempt completes the course and issues a certification with the right validity window', async () => {
      const quiz = await get(`/lms/courses/${courseId}/quiz`, learnerToken).expect(200);
      const questionIds: string[] = quiz.body.questions.map((q: { id: string }) => q.id);

      const attempt = await post(`/lms/enrollments/${enrollmentId}/quiz/attempts`, learnerToken, {
        answers: { [questionIds[0]]: 'a', [questionIds[1]]: 'b' },
      }).expect(201);
      expect(attempt.body.passed).toBe(true);
      expect(attempt.body.scorePercent).toBe(100);

      const completed = await waitFor(async () => {
        const enrollment = await get(`/lms/enrollments/${enrollmentId}`, learnerToken).expect(200);
        return enrollment.body.status === 'COMPLETED' ? enrollment.body : null;
      });
      expect(completed.completedAt).not.toBeNull();

      const myCerts = await get('/lms/certifications/me', learnerToken).expect(200);
      expect(myCerts.body).toHaveLength(1);
      const cert = myCerts.body[0];
      expect(cert.status).toBe('ACTIVE');
      const issuedAt = new Date(cert.issuedAt);
      const expiresAt = new Date(cert.expiresAt);
      // A calendar year is 365/366 days, not 12*30 — allow the real variance
      // instead of a naive 30-day-month approximation.
      const approxYearMs = 365.25 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - issuedAt.getTime() - approxYearMs)).toBeLessThan(3 * 24 * 60 * 60 * 1000);
    });
  });

  describe('Admin assignment, the real 0.8 notification hub, and the training calendar', () => {
    it('HR assigns a course with a due date; the assignee is notified and sees it on their calendar', async () => {
      const course = await post('/lms/courses', tokenHrA, { title: 'Fire Safety' }).expect(201);
      await post(`/lms/courses/${course.body.id}/content`, tokenHrA, { orderIndex: 0, type: 'DOCUMENT', title: 'Fire safety handbook' }).expect(201);
      await post(`/lms/courses/${course.body.id}/publish`, tokenHrA, {}).expect(201);

      const fixture = await makeEmployeeWithUser(tenantAId, branchAId);
      const dueDate = '2026-12-01';
      const assignment = await post(`/lms/courses/${course.body.id}/assign`, tokenHrA, {
        employeeId: fixture.employee.id,
        dueDate,
      }).expect(201);
      expect(assignment.body.source).toBe('ASSIGNED');

      await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { tenantId: tenantAId, recipientUserId: fixture.user.id, eventType: 'lms.course_assigned' },
        });
        return rows.length >= 1 ? rows : null;
      });

      const calendar = await get(`/lms/calendar?from=2026-11-01&to=2026-12-31&branchId=${branchAId}`, tokenHrA).expect(200);
      expect(calendar.body.some((entry: { type: string; employeeId: string }) => entry.type === 'ENROLLMENT_DUE' && entry.employeeId === fixture.employee.id)).toBe(true);

      // Assigning again while the first assignment is still active is rejected.
      await post(`/lms/courses/${course.body.id}/assign`, tokenHrA, { employeeId: fixture.employee.id }).expect(409);
    });
  });

  describe('Required-training compliance — the live drill-down, and the real scheduled rollup', () => {
    let courseId: string;

    it('flags a missing employee via the live, bounded gaps drill-down', async () => {
      const course = await post('/lms/courses', tokenHrA, { title: 'Code of Conduct' }).expect(201);
      courseId = course.body.id;
      await post(`/lms/courses/${courseId}/content`, tokenHrA, { orderIndex: 0, type: 'DOCUMENT', title: 'The handbook' }).expect(201);
      await post(`/lms/courses/${courseId}/publish`, tokenHrA, {}).expect(201);

      const fixture = await makeEmployeeWithUser(tenantAId, branchAId);
      await post('/lms/required-trainings', tokenHrA, { courseId, branchId: branchAId }).expect(201);

      const gaps = await get(`/lms/compliance/gaps?branchId=${branchAId}&courseId=${courseId}`, tokenHrA).expect(200);
      expect(gaps.body.some((row: { employeeId: string; bucket: string }) => row.employeeId === fixture.employee.id && row.bucket === 'MISSING')).toBe(true);
    });

    it('the scheduled rollup job populates the compliance dashboard — proven via the real BullMQ job, never a live aggregate', async () => {
      const rollupDate = new Date().toISOString();
      await post('/lms/rollup/run', tokenAdminA, { date: rollupDate }).expect(201);

      const dashboard = await waitFor(async () => {
        const res = await get(`/lms/compliance/dashboard?branchId=${branchAId}&courseId=${courseId}&to=${rollupDate}`, tokenHrA).expect(200);
        const row = res.body.compliance.find((r: { courseId: string }) => r.courseId === courseId);
        return row && row.requiredCount > 0 ? row : null;
      });
      expect(dashboard.missingCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Certification-expiry reminders — idempotent, and the EXPIRING -> EXPIRED transition', () => {
    let certificationId: string;
    let learnerUserId: string;

    beforeAll(async () => {
      const course = await post('/lms/courses', tokenHrA, { title: 'Annual Compliance Refresher', validityMonths: 1 }).expect(201);
      const item = await post(`/lms/courses/${course.body.id}/content`, tokenHrA, { orderIndex: 0, type: 'DOCUMENT', title: 'Refresher doc' }).expect(201);
      await post(`/lms/courses/${course.body.id}/publish`, tokenHrA, {}).expect(201);

      const fixture = await makeEmployeeWithUser(tenantAId, branchAId);
      learnerUserId = fixture.user.id;
      const enrollment = await post(`/lms/courses/${course.body.id}/enroll`, fixture.token, {}).expect(201);
      await post(`/lms/enrollments/${enrollment.body.id}/content/${item.body.id}/complete`, fixture.token, {}).expect(201);

      const cert = await prisma.certification.findFirstOrThrow({ where: { tenantId: tenantAId, enrollmentId: enrollment.body.id } });
      certificationId = cert.id;
      // Simulate "10 days from expiring" without waiting a month for real time to pass.
      await prisma.certification.update({ where: { id: cert.id }, data: { expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) } });
    });

    it('flags the EXPIRING certification and sends exactly one reminder, even after running the sweep twice', async () => {
      await post('/lms/certifications/expiry-sweep/run', tokenAdminA, {}).expect(201);

      await waitFor(async () => {
        const cert = await prisma.certification.findUniqueOrThrow({ where: { id: certificationId } });
        return cert.lastReminderBucket === 'EXPIRING' ? cert : null;
      });

      // Re-run the sweep — idempotency: no duplicate reminder for the SAME bucket.
      await post('/lms/certifications/expiry-sweep/run', tokenAdminA, {}).expect(201);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const reminders = await prisma.notification.findMany({
        where: { tenantId: tenantAId, recipientUserId: learnerUserId, eventType: 'lms.certification_expiring' },
      });
      expect(reminders).toHaveLength(1);
    });

    it('once past expiresAt, the sweep flips it to EXPIRED and sends a distinct expired reminder', async () => {
      await prisma.certification.update({ where: { id: certificationId }, data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) } });
      await post('/lms/certifications/expiry-sweep/run', tokenAdminA, {}).expect(201);

      const expired = await waitFor(async () => {
        const cert = await prisma.certification.findUniqueOrThrow({ where: { id: certificationId } });
        return cert.status === 'EXPIRED' ? cert : null;
      });
      expect(expired.lastReminderBucket).toBe('EXPIRED');

      const reminders = await prisma.notification.findMany({
        where: { tenantId: tenantAId, recipientUserId: learnerUserId, eventType: 'lms.certification_expired' },
      });
      expect(reminders).toHaveLength(1);
    });
  });

  describe('Cross-tenant isolation', () => {
    it('tenant B sees no courses or categories from tenant A', async () => {
      const courses = await get('/lms/courses', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(courses.body).toEqual([]);
      const categories = await get('/lms/categories', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(categories.body).toEqual([]);
    });
  });
});
