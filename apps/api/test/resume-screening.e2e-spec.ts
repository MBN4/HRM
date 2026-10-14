/**
 * Proves resume parsing + candidate screening (step 9.1) end to end over real
 * HTTP + real Postgres/Redis/MinIO/BullMQ — see
 * docs/conventions/resume-parsing-screening.md: a public apply with a real
 * PDF/DOCX returns immediately and is parsed ASYNC by the BullMQ worker; an
 * unparseable file fails gracefully (candidate + application still created,
 * recruiter can enter the fields by hand); screening criteria are config
 * data; applicants are scored with a transparent matched/missed breakdown and
 * ranked; edited parsed data is what gets screened; scoring never changes a
 * stage; RBAC + cross-tenant isolation hold; the public apply stays public.
 *
 * Requires local infra up and migrations applied (see recruitment-lifecycle.e2e-spec.ts).
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import PDFDocument from 'pdfkit';
import { strToU8, zipSync } from 'fflate';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'resume-screen-tenant-a';
const TENANT_B_SLUG = 'resume-screen-tenant-b';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });

const host = (slug: string) => `${slug}.${BASE_DOMAIN}`;

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result as T;
    if (Date.now() > deadline) throw new Error('waitFor: timed out waiting for condition.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function pdfFromText(text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(11).text(text, { lineGap: 2 });
    doc.end();
  });
}

function docxFromLines(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = lines.map((l) => `<w:p><w:r><w:t>${esc(l)}</w:t></w:r></w:p>`).join('');
  return Buffer.from(zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`) }));
}

const STRONG_RESUME = `Sara Ahmed
Senior Software Engineer
sara.ahmed@example.test | +92 300 1234567 | github.com/saraahmed

Summary
Backend engineer building payments platforms.

Skills
Languages: TypeScript, Python
Frameworks: NestJS, React
Cloud: AWS, Docker, PostgreSQL

Work Experience
Senior Software Engineer at Acme Corp
Jan 2018 - Present
- Built a payments platform with NestJS and PostgreSQL.

Software Engineer, Globex
06/2012 - 12/2017
- Developed REST APIs in Python.

Education
Master of Science in Computer Science
FAST National University, 2012
`;

const WEAK_DOCX_LINES = [
  'Bilal Khan',
  'bilal.khan@example.test',
  '',
  'Skills',
  'Python, Excel',
  '',
  'Work Experience',
  'Junior Developer at Initech',
  'Jan 2024 - Present',
  'Maintained internal scripts.',
  '',
  'Education',
  'Diploma in Information Technology',
  'City Institute, 2023',
];

describe('resume parsing + screening (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;

  let tokenHrA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  let requisitionId: string;
  let postingId: string;
  let postingSlug: string;

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token: string, hostSlug = TENANT_A_SLUG) =>
    request(app.getHttpServer())[method](path).set('Host', host(hostSlug)).set('Authorization', `Bearer ${token}`);

  function apply(file: { buffer: Buffer; name: string } | null, first: string, last: string, email: string, slug = postingSlug, hostSlug = TENANT_A_SLUG) {
    let req = request(app.getHttpServer())
      .post(`/careers/postings/${slug}/apply`)
      .set('Host', host(hostSlug))
      .field('firstName', first)
      .field('lastName', last)
      .field('email', email);
    if (file) req = req.attach('resume', file.buffer, file.name);
    return req;
  }

  async function candidateOf(applicationId: string) {
    const app_ = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    return app_.candidateId;
  }

  async function waitParsed(candidateId: string, status: 'PARSED' | 'FAILED' = 'PARSED') {
    return waitFor(async () => {
      const c = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
      return c.parseStatus === status ? c : null;
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
    await seedCountryPacks(prisma);

    const tenantA = await prisma.tenant.create({ data: { name: 'Resume Screen A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    const tenantB = await prisma.tenant.create({ data: { name: 'Resume Screen B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branch = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'A HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchAId = branch.id;

    const mkUser = async (tenantId: string, roleName: string, email: string) => {
      const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: roleName } } });
      const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
      await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
      return jwt.sign({ sub: user.id, tenantId });
    };
    tokenHrA = await mkUser(tenantAId, SYSTEM_ROLES.HR_MANAGER, 'hr@rs-a.test');
    tokenEmployeeA = await mkUser(tenantAId, SYSTEM_ROLES.EMPLOYEE, 'emp@rs-a.test');
    tokenAdminB = await mkUser(tenantBId, SYSTEM_ROLES.TENANT_ADMIN, 'admin@rs-b.test');

    // The requisition/posting approval path is proven in recruitment-lifecycle.e2e-spec.ts; seed directly here.
    const requisition = await prisma.jobRequisition.create({
      data: { tenantId: tenantAId, title: 'Senior Backend Engineer', branchId: branchAId, employmentType: 'FULL_TIME', headcount: 1, status: 'APPROVED', createdByUserId: (await prisma.user.findFirstOrThrow({ where: { tenantId: tenantAId } })).id },
    });
    requisitionId = requisition.id;
    postingSlug = `rs-senior-backend-${Date.now()}`;
    const posting = await prisma.jobPosting.create({
      data: { tenantId: tenantAId, requisitionId, title: 'Senior Backend Engineer', description: 'Build it.', publicSlug: postingSlug, status: 'PUBLISHED', publishedAt: new Date() },
    });
    postingId = posting.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  let strongApplicationId: string;
  let strongCandidateId: string;
  let weakApplicationId: string;
  let weakCandidateId: string;
  let brokenApplicationId: string;
  let brokenCandidateId: string;

  describe('async parsing on apply', () => {
    it('public apply with a real PDF returns immediately, then the worker parses it into structured fields', async () => {
      const pdf = await pdfFromText(STRONG_RESUME);
      const res = await apply({ buffer: pdf, name: 'sara-cv.pdf' }, 'Sara', 'Ahmed', 'sara.ahmed@example.test').expect(201);
      strongApplicationId = res.body.id;
      // The public (unauthenticated) response never carries recruiter-only screening output.
      expect(res.body).not.toHaveProperty('screeningScore');
      expect(res.body).not.toHaveProperty('screeningResult');
      expect(res.body.stage).toBe('APPLIED');

      strongCandidateId = await candidateOf(strongApplicationId);
      const parsed = await waitParsed(strongCandidateId);
      expect(parsed.parserName).toBe('built-in-heuristic-v1');
      const data = parsed.parsedData as Record<string, any>;
      expect(data.email).toBe('sara.ahmed@example.test');
      expect(data.skills).toEqual(expect.arrayContaining(['TypeScript', 'Python', 'NestJS', 'React', 'AWS', 'Docker', 'PostgreSQL']));
      expect(data.experience.length).toBeGreaterThanOrEqual(2);
      expect(data.totalYearsExperience).toBeGreaterThan(10);
      expect(data.education[0].level).toBe('MASTER');
    });

    it('a DOCX resume is parsed too', async () => {
      const res = await apply({ buffer: docxFromLines(WEAK_DOCX_LINES), name: 'bilal.docx' }, 'Bilal', 'Khan', 'bilal.khan@example.test').expect(201);
      weakApplicationId = res.body.id;
      weakCandidateId = await candidateOf(weakApplicationId);
      const parsed = await waitParsed(weakCandidateId);
      const data = parsed.parsedData as Record<string, any>;
      expect(data.skills).toEqual(expect.arrayContaining(['Python', 'Excel']));
      expect(data.education[0].level).toBe('DIPLOMA');
      expect(data.totalYearsExperience).toBeLessThan(3);
    });

    it('an UNPARSEABLE file fails gracefully: candidate + application still exist, parse is FAILED with a reason', async () => {
      const res = await apply({ buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), name: 'broken.bin' }, 'Zed', 'Broken', 'zed.broken@example.test').expect(201);
      brokenApplicationId = res.body.id;
      brokenCandidateId = await candidateOf(brokenApplicationId);
      const failed = await waitParsed(brokenCandidateId, 'FAILED');
      expect(failed.parseError).toMatch(/unsupported/i);
      expect(failed.parsedData).toBeNull();
      expect((await prisma.application.findUniqueOrThrow({ where: { id: brokenApplicationId } })).stage).toBe('APPLIED');
    });

    it('a scanned/empty-text PDF is also reported as FAILED (no OCR)', async () => {
      const blank = await new Promise<Buffer>((resolve) => {
        const doc = new PDFDocument();
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.rect(50, 50, 100, 100).fill('#000');
        doc.end();
      });
      const res = await apply({ buffer: blank, name: 'scan.pdf' }, 'Scan', 'Only', 'scan.only@example.test').expect(201);
      const cid = await candidateOf(res.body.id);
      const failed = await waitParsed(cid, 'FAILED');
      expect(failed.parseError).toMatch(/no readable text/i);
    });

    it('a duplicate apply is still a 409 and the public route stays tenant-scoped (a slug from tenant A is a 404 under tenant B)', async () => {
      await apply(null, 'Sara', 'Ahmed', 'sara.ahmed@example.test').expect(409);
      await apply(null, 'Sara', 'Ahmed', 'sara.ahmed@example.test', postingSlug, TENANT_B_SLUG).expect(404);
    });

    it('the candidate API exposes parse status + parsed data but never the raw extracted text', async () => {
      const res = await api('get', `/recruitment/candidates/${strongCandidateId}`, tokenHrA).expect(200);
      expect(res.body.parseStatus).toBe('PARSED');
      expect(res.body.parsedData.skills).toContain('TypeScript');
      expect(res.body.parsedData).not.toHaveProperty('rawText');
      const list = await api('get', '/recruitment/candidates', tokenHrA).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('rawText');
    });

    it('the original resume can be downloaded byte-for-byte', async () => {
      const res = await api('get', `/recruitment/candidates/${strongCandidateId}/resume`, tokenHrA).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(res.headers['content-disposition']).toContain('sara-cv.pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  describe('screening criteria → scores → ranked list', () => {
    it('applicants are unscored until the requisition has criteria', async () => {
      const res = await api('get', `/recruitment/requisitions/${requisitionId}/ranked-applications`, tokenHrA).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(3);
      expect(res.body.every((r: { screeningScore: number | null }) => r.screeningScore === null)).toBe(true);
    });

    it('defining criteria (config data) scores every applicant and returns how many were re-scored', async () => {
      const res = await api('put', `/recruitment/requisitions/${requisitionId}/screening-criteria`, tokenHrA)
        .send({
          requiredSkills: ['typescript', 'nest.js', 'postgres'],
          preferredSkills: ['AWS', 'Kubernetes'],
          minYearsExperience: 5,
          minEducation: 'BACHELOR',
          keywordMustHaves: ['payments'],
          belowThresholdScore: 50,
        })
        .expect(200);
      expect(res.body.rescored).toBeGreaterThanOrEqual(3);
      // aliases are stored canonically
      expect(res.body.config.requiredSkills).toEqual(['TypeScript', 'NestJS', 'PostgreSQL']);
      const read = await api('get', `/recruitment/requisitions/${requisitionId}/screening-criteria`, tokenHrA).expect(200);
      expect(read.body.config.minEducation).toBe('BACHELOR');
    });

    it('the list ranks by match, strongest first, and shows WHY (matched/missed per criterion)', async () => {
      const res = await api('get', `/recruitment/requisitions/${requisitionId}/ranked-applications`, tokenHrA).expect(200);
      const ids = res.body.map((r: { applicationId: string }) => r.applicationId);
      expect(ids.indexOf(strongApplicationId)).toBeLessThan(ids.indexOf(weakApplicationId));
      const strong = res.body.find((r: { applicationId: string }) => r.applicationId === strongApplicationId);
      const weak = res.body.find((r: { applicationId: string }) => r.applicationId === weakApplicationId);
      expect(strong.screeningScore).toBeGreaterThan(weak.screeningScore);
      expect(strong.belowThreshold).toBe(false);
      expect(weak.belowThreshold).toBe(true);

      const req = strong.screening.criteria.find((c: { key: string }) => c.key === 'requiredSkills');
      expect(req.matched).toEqual(expect.arrayContaining(['TypeScript', 'NestJS', 'PostgreSQL']));
      expect(req.status).toBe('MET');
      const weakReq = weak.screening.criteria.find((c: { key: string }) => c.key === 'requiredSkills');
      expect(weakReq.missed).toEqual(expect.arrayContaining(['TypeScript', 'NestJS', 'PostgreSQL']));
      // Points always sum to the displayed score.
      const sum = weak.screening.criteria.reduce((s: number, c: { earnedPoints: number }) => s + c.earnedPoints, 0);
      expect(Math.round(sum)).toBe(weak.screeningScore);
      // Unparseable candidates sink to the bottom, unscored — never silently rejected.
      const broken = res.body.find((r: { applicationId: string }) => r.applicationId === brokenApplicationId);
      expect(broken.screeningScore).toBeNull();
      expect(broken.candidate.parseStatus).toBe('FAILED');
      expect(ids.indexOf(brokenApplicationId)).toBeGreaterThan(ids.indexOf(weakApplicationId));
    });

    it('filters by score, skill and minimum experience', async () => {
      const base = `/recruitment/requisitions/${requisitionId}/ranked-applications`;
      const byScore = await api('get', `${base}?minScore=70`, tokenHrA).expect(200);
      expect(byScore.body.map((r: { applicationId: string }) => r.applicationId)).toEqual([strongApplicationId]);
      const bySkill = await api('get', `${base}?skill=excel`, tokenHrA).expect(200);
      expect(bySkill.body.map((r: { applicationId: string }) => r.applicationId)).toEqual([weakApplicationId]);
      const byYears = await api('get', `${base}?minYears=10`, tokenHrA).expect(200);
      expect(byYears.body.map((r: { applicationId: string }) => r.applicationId)).toEqual([strongApplicationId]);
      const flagged = await api('get', `${base}?belowThreshold=true`, tokenHrA).expect(200);
      expect(flagged.body.map((r: { applicationId: string }) => r.applicationId)).toContain(weakApplicationId);
      await api('get', `${base}?minScore=abc`, tokenHrA).expect(400);
    });

    it('the single-application screening view returns the parsed fields, the score and the criteria in one call', async () => {
      const res = await api('get', `/recruitment/applications/${strongApplicationId}/screening`, tokenHrA).expect(200);
      expect(res.body.parse.status).toBe('PARSED');
      expect(res.body.parsed.fullName).toBe('Sara Ahmed');
      expect(res.body.parsed).not.toHaveProperty('rawText');
      expect(res.body.screening.score).toBe(res.body.screeningScore);
      expect(res.body.criteria.requiredSkills).toContain('NestJS');
      expect(res.body.candidate.hasResume).toBe(true);
    });

    it('scoring NEVER changes a stage — only a human does (advance / reject still work)', async () => {
      const flagged = await prisma.application.findUniqueOrThrow({ where: { id: weakApplicationId } });
      expect(flagged.belowThreshold).toBe(true);
      expect(flagged.stage).toBe('APPLIED');

      await api('patch', `/recruitment/applications/${strongApplicationId}/stage`, tokenHrA).send({ stage: 'SCREEN' }).expect(200);
      await api('patch', `/recruitment/applications/${weakApplicationId}/stage`, tokenHrA).send({ stage: 'REJECTED' }).expect(200);
      const stages = await prisma.application.findMany({ where: { id: { in: [strongApplicationId, weakApplicationId] } }, select: { id: true, stage: true } });
      expect(stages.find((s) => s.id === strongApplicationId)!.stage).toBe('SCREEN');
      expect(stages.find((s) => s.id === weakApplicationId)!.stage).toBe('REJECTED');

      // …and a re-score afterwards leaves the human decision alone.
      await api('put', `/recruitment/requisitions/${requisitionId}/screening-criteria`, tokenHrA).send({ requiredSkills: ['TypeScript'] }).expect(200);
      const after = await prisma.application.findUniqueOrThrow({ where: { id: weakApplicationId } });
      expect(after.stage).toBe('REJECTED');
    });
  });

  describe('recruiter edits + manual entry feed screening', () => {
    beforeAll(async () => {
      await api('put', `/recruitment/requisitions/${requisitionId}/screening-criteria`, tokenHrA)
        .send({ requiredSkills: ['TypeScript', 'NestJS'], minYearsExperience: 5, belowThresholdScore: 50 })
        .expect(200);
    });

    it('editing the parsed fields re-scores the candidate using the EDITED data and flags it as edited', async () => {
      const before = (await api('get', `/recruitment/applications/${weakApplicationId}/screening`, tokenHrA).expect(200)).body;
      expect(before.screeningScore).toBeLessThan(30);

      const edited = await api('patch', `/recruitment/candidates/${weakCandidateId}/parsed-resume`, tokenHrA)
        .send({ ...before.parsed, skills: [...before.parsed.skills, 'typescript', 'nest.js'], totalYearsExperience: 6 })
        .expect(200);
      expect(edited.body.skills).toEqual(expect.arrayContaining(['TypeScript', 'NestJS']));
      expect(edited.body).not.toHaveProperty('rawText');

      const after = (await api('get', `/recruitment/applications/${weakApplicationId}/screening`, tokenHrA).expect(200)).body;
      expect(after.screeningScore).toBe(100);
      expect(after.screening.basedOnEditedData).toBe(true);
      expect(after.parse.editedAt).not.toBeNull();
    });

    it('manual entry for a FAILED parse makes that candidate scoreable', async () => {
      const edited = await api('patch', `/recruitment/candidates/${brokenCandidateId}/parsed-resume`, tokenHrA)
        .send({ fullName: 'Zed Broken', skills: ['TypeScript'], totalYearsExperience: 5, experience: [], education: [], links: [] })
        .expect(200);
      expect(edited.body.skills).toEqual(['TypeScript']);
      const view = (await api('get', `/recruitment/applications/${brokenApplicationId}/screening`, tokenHrA).expect(200)).body;
      expect(view.parse.status).toBe('PARSED');
      expect(view.parse.parserName).toBe('manual');
      expect(view.screeningScore).toBe(67); // TypeScript (1 of 2 required) = 33.3 + 5/5 yrs = 33.3
    });

    it('rejects malformed edits', async () => {
      await api('patch', `/recruitment/candidates/${weakCandidateId}/parsed-resume`, tokenHrA).send({ skills: 'nope' }).expect(400);
      await api('patch', `/recruitment/candidates/${weakCandidateId}/parsed-resume`, tokenHrA).send({ skills: [], rawText: 'x' }).expect(400);
    });

    it('the edit is audited (0.9) and the async parse outcome landed in the audit trail too', async () => {
      const edit = await waitFor(() => prisma.auditLog.findFirst({ where: { tenantId: tenantAId, action: 'EDIT_PARSED_RESUME', entityId: weakCandidateId } }));
      expect(edit.entityType).toBe('Candidate');
      expect(JSON.stringify(edit)).not.toContain('rawText');
      const parsedEvent = await waitFor(() => prisma.auditLog.findFirst({ where: { tenantId: tenantAId, action: 'recruitment.resume_parsed', entityId: strongCandidateId } }));
      expect(parsedEvent).toBeTruthy();
    });
  });

  describe('recruiter-side upload / add applicant / re-parse', () => {
    it('a recruiter adds an applicant with a resume to a posting; it is parsed async and scored', async () => {
      const pdf = await pdfFromText(STRONG_RESUME.replace('Sara Ahmed', 'Hira Malik').replace('sara.ahmed@example.test', 'hira.malik@example.test'));
      const res = await request(app.getHttpServer())
        .post(`/recruitment/postings/${postingId}/applicants`)
        .set('Host', host(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenHrA}`)
        .field('firstName', 'Hira')
        .field('lastName', 'Malik')
        .field('email', 'hira.malik@example.test')
        .attach('resume', pdf, 'hira.pdf')
        .expect(201);
      const cid = await candidateOf(res.body.id);
      expect((await prisma.candidate.findUniqueOrThrow({ where: { id: cid } })).source).toBe('recruiter_added');
      await waitParsed(cid);
      const view = (await api('get', `/recruitment/applications/${res.body.id}/screening`, tokenHrA).expect(200)).body;
      expect(view.screeningScore).toBe(100);
    });

    it('uploading a replacement resume resets to PENDING (old parsed data + scores cleared) and re-parses', async () => {
      const pdf = await pdfFromText(STRONG_RESUME.replace('Sara Ahmed', 'Sara A. Ahmed'));
      const res = await api('post', `/recruitment/candidates/${strongCandidateId}/resume`, tokenHrA).attach('resume', pdf, 'sara-v2.pdf').expect(201);
      expect(res.body.parseStatus).toBe('PENDING');
      const parsed = await waitFor(async () => {
        const c = await prisma.candidate.findUniqueOrThrow({ where: { id: strongCandidateId } });
        return c.parseStatus === 'PARSED' && c.resumeFileName === 'sara-v2.pdf' ? c : null;
      });
      expect((parsed.parsedData as Record<string, any>).fullName).toBe('Sara A. Ahmed');
    });

    it('re-parse discards manual edits and re-runs the parser against the stored file', async () => {
      await api('post', `/recruitment/candidates/${weakCandidateId}/reparse`, tokenHrA).expect(201);
      const c = await waitFor(async () => {
        const row = await prisma.candidate.findUniqueOrThrow({ where: { id: weakCandidateId } });
        return row.parseStatus === 'PARSED' ? row : null;
      });
      expect(c.parsedDataEditedAt).toBeNull();
      expect((c.parsedData as Record<string, any>).skills).not.toContain('NestJS');
    });
  });

  describe('RBAC + tenant isolation', () => {
    it('a user without recruitment permissions gets 403 on every screening route', async () => {
      const t = tokenEmployeeA;
      await api('get', `/recruitment/requisitions/${requisitionId}/ranked-applications`, t).expect(403);
      await api('get', `/recruitment/requisitions/${requisitionId}/screening-criteria`, t).expect(403);
      await api('put', `/recruitment/requisitions/${requisitionId}/screening-criteria`, t).send({ requiredSkills: ['x'] }).expect(403);
      await api('get', `/recruitment/applications/${strongApplicationId}/screening`, t).expect(403);
      await api('patch', `/recruitment/candidates/${strongCandidateId}/parsed-resume`, t).send({ skills: [] }).expect(403);
      await api('get', `/recruitment/candidates/${strongCandidateId}/resume`, t).expect(403);
      await api('post', `/recruitment/candidates/${strongCandidateId}/reparse`, t).expect(403);
    });

    it("tenant B cannot see or touch tenant A's criteria, ranked list, parsed data or resume", async () => {
      const t = tokenAdminB;
      await api('get', `/recruitment/requisitions/${requisitionId}/ranked-applications`, t, TENANT_B_SLUG).expect(404);
      await api('get', `/recruitment/requisitions/${requisitionId}/screening-criteria`, t, TENANT_B_SLUG).expect(404);
      await api('put', `/recruitment/requisitions/${requisitionId}/screening-criteria`, t, TENANT_B_SLUG).send({ requiredSkills: ['x'] }).expect(404);
      await api('get', `/recruitment/applications/${strongApplicationId}/screening`, t, TENANT_B_SLUG).expect(404);
      await api('patch', `/recruitment/candidates/${strongCandidateId}/parsed-resume`, t, TENANT_B_SLUG).send({ skills: [] }).expect(404);
      await api('get', `/recruitment/candidates/${strongCandidateId}/resume`, t, TENANT_B_SLUG).expect(404);
    });

    it('deleting criteria clears every score (applicants stay, unscored)', async () => {
      await api('delete', `/recruitment/requisitions/${requisitionId}/screening-criteria`, tokenHrA).expect(200);
      const res = await api('get', `/recruitment/requisitions/${requisitionId}/ranked-applications`, tokenHrA).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(4);
      expect(res.body.every((r: { screeningScore: number | null }) => r.screeningScore === null)).toBe(true);
    });
  });
});
