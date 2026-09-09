/**
 * Proves the e-signature module (step 3.5.3) end to end over real HTTP —
 * see docs/conventions/e-signatures.md: an internal signer's evidentiary
 * trail (identity/UTC timestamp/IP/user-agent/signing method/document
 * hash), a certificate generated on completion, an EXTERNAL signer (no
 * account) signing an offer letter via a single-document-scoped, expiring
 * link with NO RBAC/JWT at all, the signed offer flowing straight into the
 * REAL 2.3 onboarding trigger with zero changes to Recruitment/Onboarding,
 * a policy acknowledgment upgraded to a signed one, document-hash
 * tamper-evidence, and cross-tenant isolation (including the external
 * link, via RLS).
 *
 * `EMAIL_PROVIDER` is overridden with a capturing mock for the whole file —
 * the only way to recover the raw signing token an external signer would
 * actually receive by email (the module never returns it via any API
 * response), the same `.overrideProvider(EMAIL_PROVIDER)` technique
 * notifications.e2e-spec.ts already establishes for its own slow-provider
 * test.
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
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { EMAIL_PROVIDER } from '../src/notifications/providers/notification-provider.tokens';
import { StorageService } from '../src/storage/storage.service';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'esig-test-tenant-a';
const TENANT_B_SLUG = 'esig-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 10000, intervalMs = 150): Promise<T> {
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

// A 1x1 transparent PNG, base64-encoded — a real (if trivial) image byte
// stream for the DRAWN_SIGNATURE path.
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('e-signatures (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let capturedEmails: NotificationProviderSendParams[];

  let tenantAId: string;
  let tenantBId: string;
  let branchUsId: string;

  let tokenAdminA: string;
  let tokenAdminB: string;
  let employeeUserAId: string;
  let tokenEmployeeA: string;

  function post(path: string, token: string | null, body: unknown, host = TENANT_A_SLUG) {
    const req = request(app.getHttpServer()).post(path).set('Host', hostFor(host));
    return token ? req.set('Authorization', `Bearer ${token}`).send(body) : req.send(body);
  }
  function get(path: string, token: string | null, host = TENANT_A_SLUG) {
    const req = request(app.getHttpServer()).get(path).set('Host', hostFor(host));
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function makeUserWithRole(tenantId: string, roleId: string, email: string) {
    const user = await prisma.user.create({ data: { tenantId, email, hashedPassword: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    return user;
  }

  beforeAll(async () => {
    capturedEmails = [];
    const capturingEmailProvider: NotificationProvider = {
      send: async (params) => {
        capturedEmails.push(params);
      },
    };

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_PROVIDER)
      .useValue(capturingEmailProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'E-Sign Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'E-Sign Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchUs = await prisma.branch.create({ data: { tenantId: tenantAId, name: 'E-Sign US HQ', countryCode: 'US', timezone: 'America/New_York' } });
    branchUsId = branchUs.id;

    const adminRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const adminRoleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } } });

    const adminA = await makeUserWithRole(tenantAId, adminRoleA.id, 'admin@esig-a.test');
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    const adminB = await makeUserWithRole(tenantBId, adminRoleB.id, 'admin@esig-b.test');
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    const employeeUserA = await makeUserWithRole(tenantAId, employeeRoleA.id, 'employee@esig-a.test');
    employeeUserAId = employeeUserA.id;
    tokenEmployeeA = jwt.sign({ sub: employeeUserA.id, tenantId: tenantAId });
    await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        branchId: branchUsId,
        employeeCode: 'ESIG-1',
        firstName: 'Jamie',
        lastName: 'Signer',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2026-01-01'),
        status: 'ACTIVE',
        userId: employeeUserA.id,
      },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('internal signer — evidentiary trail + certificate', () => {
    let requestId: string;
    let signerId: string;

    it('an admin creates a generated (CUSTOM) signature request for an internal signer', async () => {
      const res = await post('/e-signatures/requests', tokenAdminA, {
        title: 'Confidentiality Agreement',
        generate: { kind: 'CUSTOM', title: 'Confidentiality Agreement', paragraphs: ['This agreement binds the undersigned to confidentiality.'] },
        signers: [{ signerType: 'INTERNAL', order: 0, userId: employeeUserAId }],
      }).expect(201);
      requestId = res.body.id;
      expect(res.body.status).toBe('DRAFT');
      expect(typeof res.body.documentHash).toBe('string');
      expect(res.body.documentHash).toHaveLength(64);
    });

    it('sending it activates the internal signer', async () => {
      const res = await post(`/e-signatures/requests/${requestId}/send`, tokenAdminA, {}).expect(201);
      expect(res.body.status).toBe('SENT');

      const detail = await get(`/e-signatures/requests/${requestId}`, tokenAdminA).expect(200);
      expect(detail.body.signers).toHaveLength(1);
      expect(detail.body.signers[0].status).toBe('SENT');
      signerId = detail.body.signers[0].id;
    });

    it("the signer sees it in their pending list and can view the document (marking it VIEWED)", async () => {
      const pending = await get('/e-signatures/my-pending', tokenEmployeeA).expect(200);
      expect(pending.body.map((s: { id: string }) => s.id)).toContain(signerId);

      const doc = await get(`/e-signatures/my-signatures/${signerId}/document`, tokenEmployeeA).expect(200);
      expect(doc.headers['content-type']).toContain('application/pdf');
    });

    it('the signer signs (typed name) — capturing identity, UTC timestamp, IP/user-agent, method, and document hash', async () => {
      const res = await request(app.getHttpServer())
        .post(`/e-signatures/my-signatures/${signerId}/sign`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenEmployeeA}`)
        .set('User-Agent', 'ESignTestAgent/1.0')
        .send({ signingMethod: 'TYPED_NAME', typedSignatureText: 'Jamie Signer', consent: true })
        .expect(201);
      expect(res.body.status).toBe('SIGNED');
    });

    it('the request completes and a certificate is generated', async () => {
      const completed = await waitFor(async () => {
        const res = await get(`/e-signatures/requests/${requestId}`, tokenAdminA).expect(200);
        return res.body.status === 'COMPLETED' ? res.body : null;
      });
      expect(completed.completedAt).toBeTruthy();
      expect(completed.certificate).toBeTruthy();

      const certificate = await get(`/e-signatures/requests/${requestId}/certificate`, tokenAdminA).expect(200);
      expect(certificate.headers['content-type']).toContain('application/pdf');
      expect(certificate.body.length).toBeGreaterThan(0);
    });

    it('the trail is immutable and legally complete — a SIGNED event carries identity/UTC time/IP/UA/method/hash', async () => {
      const events = await get(`/e-signatures/requests/${requestId}/events`, tokenAdminA).expect(200);
      const signedEvent = events.body.find((e: { eventType: string }) => e.eventType === 'SIGNED');
      expect(signedEvent).toBeTruthy();
      expect(signedEvent.actorUserId).toBe(employeeUserAId);
      expect(signedEvent.signingMethod).toBe('TYPED_NAME');
      expect(signedEvent.userAgent).toBe('ESignTestAgent/1.0');
      expect(typeof signedEvent.ipAddress).toBe('string');
      expect(signedEvent.documentHash).toHaveLength(64);
      expect(new Date(signedEvent.occurredAt).toISOString()).toBe(signedEvent.occurredAt);

      const certificateEvent = events.body.find((e: { eventType: string }) => e.eventType === 'CERTIFICATE_GENERATED');
      expect(certificateEvent).toBeTruthy();

      // DB-level immutability itself (REVOKE UPDATE/DELETE from hrm_app) is
      // proven directly, at the Postgres layer, by
      // packages/db/test/signature-event-immutability.spec.ts — this test
      // just proves the trail's CONTENT is complete.
    });

    it('document-hash tamper-evidence: altering the stored document after signing is detectable', async () => {
      const before = await get(`/e-signatures/requests/${requestId}/verify`, tokenAdminA).expect(200);
      expect(before.body.valid).toBe(true);
      expect(before.body.expectedHash).toBe(before.body.actualHash);

      const detail = await get(`/e-signatures/requests/${requestId}`, tokenAdminA).expect(200);
      const storage = moduleRef.get(StorageService);
      await storage.uploadObject({ key: detail.body.documentStorageKey, body: Buffer.from('tampered bytes'), contentType: 'application/pdf' });

      const after = await get(`/e-signatures/requests/${requestId}/verify`, tokenAdminA).expect(200);
      expect(after.body.valid).toBe(false);
      expect(after.body.actualHash).not.toBe(after.body.expectedHash);
    });
  });

  describe('external signer — offer letter, no account, expiring single-document link', () => {
    let offerId: string;
    let candidateId: string;
    let applicationId: string;
    let requestId: string;
    let externalToken: string;

    beforeAll(async () => {
      const candidate = await prisma.candidate.create({
        data: { tenantId: tenantAId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@esig-candidates.test' },
      });
      candidateId = candidate.id;
      const requisition = await prisma.jobRequisition.create({
        data: { tenantId: tenantAId, title: 'Engineer', branchId: branchUsId, employmentType: 'FULL_TIME', status: 'APPROVED', createdByUserId: employeeUserAId },
      });
      const posting = await prisma.jobPosting.create({
        data: { tenantId: tenantAId, requisitionId: requisition.id, title: 'Engineer', description: 'Build things.', publicSlug: 'esig-engineer', status: 'PUBLISHED' },
      });
      const application = await prisma.application.create({ data: { tenantId: tenantAId, candidateId, jobPostingId: posting.id } });
      applicationId = application.id;
      const offer = await prisma.offer.create({
        data: {
          tenantId: tenantAId,
          applicationId,
          branchId: branchUsId,
          employmentType: 'FULL_TIME',
          proposedSalary: '95000',
          salaryCurrency: 'USD',
          proposedJoinDate: new Date('2026-11-01'),
          status: 'APPROVED',
          createdByUserId: employeeUserAId,
        },
      });
      offerId = offer.id;
    });

    it('an admin creates a GENERATED offer-letter signature request for the candidate (an external signer)', async () => {
      const res = await post('/e-signatures/requests', tokenAdminA, {
        generate: { kind: 'OFFER_LETTER', offerId },
        signers: [{ signerType: 'EXTERNAL', order: 0, externalName: 'Ada Lovelace', externalEmail: 'ada@esig-candidates.test' }],
      }).expect(201);
      requestId = res.body.id;
      expect(res.body.entityType).toBe('Offer');
      expect(res.body.entityId).toBe(offerId);
    });

    it('sending it emails the candidate a signing link — no account, no JWT', async () => {
      await post(`/e-signatures/requests/${requestId}/send`, tokenAdminA, {}).expect(201);

      const email = await waitFor(async () => capturedEmails.find((e) => e.to === 'ada@esig-candidates.test') ?? null);
      const match = email.body.match(/\/esign\/([^\s?]+)\?tenant=/);
      expect(match).toBeTruthy();
      externalToken = match![1];
    });

    it('the external signer views and signs (drawn signature) via the token link alone', async () => {
      const view = await request(app.getHttpServer())
        .get(`/e-signatures/sign/${externalToken}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .expect(200);
      expect(view.body.requestTitle).toContain('Offer Letter');

      const doc = await request(app.getHttpServer()).get(`/e-signatures/sign/${externalToken}/document`).set('Host', hostFor(TENANT_A_SLUG)).expect(200);
      expect(doc.headers['content-type']).toContain('application/pdf');

      const sign = await request(app.getHttpServer())
        .post(`/e-signatures/sign/${externalToken}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('User-Agent', 'ExternalCandidateBrowser/1.0')
        .send({ signingMethod: 'DRAWN_SIGNATURE', signatureImageBase64: TINY_PNG_BASE64, consent: true })
        .expect(201);
      expect(sign.body.status).toBe('SIGNED');
    });

    it('the signed offer flows into the REAL offer-accept + onboarding trigger — zero changes to Recruitment/Onboarding', async () => {
      const acceptedOffer = await waitFor(async () => {
        const res = await get(`/recruitment/offers/${offerId}`, tokenAdminA).expect(200);
        return res.body.status === 'ACCEPTED' ? res.body : null;
      });
      expect(acceptedOffer.acceptedAt).toBeTruthy();

      const hiredApplication = await get(`/recruitment/applications/${applicationId}`, tokenAdminA).expect(200);
      expect(hiredApplication.body.stage).toBe('HIRED');

      const onboarding = await waitFor(async () => prisma.onboardingProcess.findUnique({ where: { tenantId_offerId: { tenantId: tenantAId, offerId } } }));
      expect(onboarding.candidateId).toBe(candidateId);
    });

    it("the external token is single-document-scoped — it is not a general credential", async () => {
      // Not a valid JWT at all — a completely unrelated authenticated route
      // rejects it outright.
      await request(app.getHttpServer())
        .get('/employees')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${externalToken}`)
        .expect(401);
    });

    it('the external link cannot cross tenants (RLS) — the SAME token 404s under a different tenant Host', async () => {
      await request(app.getHttpServer()).get(`/e-signatures/sign/${externalToken}`).set('Host', hostFor(TENANT_B_SLUG)).expect(404);
    });

    it('an expired external link is rejected (410 Gone)', async () => {
      const secondCandidateEmail = 'grace@esig-candidates.test';
      const secondRequest = await post('/e-signatures/requests', tokenAdminA, {
        generate: { kind: 'CUSTOM', title: 'Expiring Doc', paragraphs: ['Content.'] },
        signers: [{ signerType: 'EXTERNAL', order: 0, externalName: 'Grace Hopper', externalEmail: secondCandidateEmail }],
      }).expect(201);
      await post(`/e-signatures/requests/${secondRequest.body.id}/send`, tokenAdminA, {}).expect(201);

      const email = await waitFor(async () => capturedEmails.find((e) => e.to === secondCandidateEmail) ?? null);
      const match = email.body.match(/\/esign\/([^\s?]+)\?tenant=/);
      const token = match![1];

      await prisma.signatureSigner.updateMany({
        where: { tenantId: tenantAId, signatureRequestId: secondRequest.body.id },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });

      await request(app.getHttpServer()).get(`/e-signatures/sign/${token}`).set('Host', hostFor(TENANT_A_SLUG)).expect(410);
    });
  });

  describe('policy acknowledgment upgraded to a signed acknowledgment', () => {
    let policyId: string;

    it('an admin publishes a policy that requires a signature', async () => {
      const res = await post('/policies', tokenAdminA, {
        title: 'Code of Conduct',
        body: 'All employees must act with integrity.\n\nViolations will be investigated.',
        requiresAcknowledgment: true,
        requiresSignature: true,
        publish: true,
      }).expect(201);
      policyId = res.body.id;
    });

    it('a plain click-to-acknowledge is refused once a policy requires a signature', async () => {
      await post(`/policies/${policyId}/acknowledge`, tokenEmployeeA, {}).expect(409);
    });

    it('the employee self-requests a signature for their own acknowledgment (POLICY_READ, not esignature.request)', async () => {
      const res = await post('/e-signatures/requests', tokenEmployeeA, {
        generate: { kind: 'POLICY', policyId },
        signers: [{ signerType: 'INTERNAL', order: 0, userId: employeeUserAId }],
      }).expect(201);
      expect(res.body.entityType).toBe('Policy');

      await post(`/e-signatures/requests/${res.body.id}/send`, tokenAdminA, {}).expect(201);
      const detail = await get(`/e-signatures/requests/${res.body.id}`, tokenAdminA).expect(200);
      const signerId = detail.body.signers[0].id;

      await request(app.getHttpServer())
        .post(`/e-signatures/my-signatures/${signerId}/sign`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenEmployeeA}`)
        .send({ signingMethod: 'CLICK_TO_SIGN', consent: true })
        .expect(201);

      const ack = await waitFor(async () =>
        prisma.policyAcknowledgment.findUnique({ where: { tenantId_policyId_userId: { tenantId: tenantAId, policyId, userId: employeeUserAId } } }),
      );
      expect(ack.acknowledgedAt).toBeTruthy();
    });

    it('a caller without esignature.request or POLICY_READ ownership cannot self-request on behalf of someone else', async () => {
      const otherEmployeeRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
      const otherUser = await makeUserWithRole(tenantAId, otherEmployeeRole.id, 'other@esig-a.test');
      const otherToken = jwt.sign({ sub: otherUser.id, tenantId: tenantAId });

      await post('/e-signatures/requests', otherToken, {
        generate: { kind: 'POLICY', policyId },
        signers: [{ signerType: 'INTERNAL', order: 0, userId: employeeUserAId }],
      }).expect(403);
    });
  });

  describe('RBAC + cross-tenant isolation', () => {
    it('a caller without esignature.request cannot create a generic signature request', async () => {
      await post('/e-signatures/requests', tokenEmployeeA, {
        generate: { kind: 'CUSTOM', title: 'x', paragraphs: ['y'] },
        signers: [{ signerType: 'INTERNAL', order: 0, userId: employeeUserAId }],
      }).expect(403);
    });

    it('a caller without esignature.manage cannot list requests', async () => {
      await get('/e-signatures/requests', tokenEmployeeA).expect(403);
    });

    it("tenant B cannot see tenant A's signature requests", async () => {
      const res = await get('/e-signatures/requests', tokenAdminB, TENANT_B_SLUG).expect(200);
      expect(res.body).toEqual([]);
    });
  });
});
