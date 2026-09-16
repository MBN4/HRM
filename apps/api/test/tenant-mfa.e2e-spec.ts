/**
 * Proves optional tenant-user MFA (step 6.2) end to end over real HTTP —
 * see docs/conventions/security-hardening.md → Tenant MFA. Mirrors
 * `apps/api/test/platform-auth.e2e-spec.ts`'s own MFA proof shape, applied
 * to the OPTIONAL tenant flow instead of platform's mandatory one:
 *   - A user with no MFA enrolled logs in with password alone (existing
 *     auth-rbac.e2e-spec.ts already proves this; not re-asserted here).
 *   - Enroll -> wrong code rejected, doesn't enable MFA -> correct code
 *     enables it and returns one-time recovery codes.
 *   - Once enabled, login returns a `mfaRequired` challenge, NOT tokens,
 *     until `POST /auth/mfa/verify` succeeds with either a TOTP code or a
 *     recovery code (each usable exactly once).
 *   - The MFA verify step is itself rate-limited, separately from the
 *     password step.
 *   - A challenge token is tenant-scoped: presenting it under a different
 *     tenant's Host header never validates.
 *   - Disabling MFA requires BOTH the current password AND a valid code,
 *     and revokes every other live session.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { generateTotp } from '../src/platform/auth/totp.util';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'mfa-test-tenant-a';
const TENANT_B_SLUG = 'mfa-test-tenant-b';
const PASSWORD = 'correct-horse-battery-staple';

const password = new PasswordService();
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('tenant MFA (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let userEmail: string;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'MFA Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'MFA Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantB.id);

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    userEmail = 'mfa-user@a.test';
    const hashedPassword = await password.hash(PASSWORD);
    const user = await prisma.user.create({ data: { tenantId: tenantAId, email: userEmail, hashedPassword, status: 'ACTIVE' } });
    userId = user.id;
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: user.id, roleId: adminRole.id } });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await redis.quit();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function login(slug: string, email: string, pw = PASSWORD) {
    return request(app.getHttpServer()).post('/auth/login').set('Host', hostFor(slug)).send({ email, password: pw });
  }

  async function authHeader(): Promise<string> {
    const res = await login(TENANT_A_SLUG, userEmail).expect(200);
    return `Bearer ${res.body.accessToken as string}`;
  }

  let secret: string;
  let recoveryCodes: string[];

  describe('enrollment', () => {
    it('starts enrollment for an authenticated caller and returns a secret + otpauth URL', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/mfa/enroll')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', await authHeader())
        .expect(200);

      expect(res.body.secret).toEqual(expect.any(String));
      expect(res.body.otpauthUrl).toContain('otpauth://totp/');
      secret = res.body.secret;
    });

    it('rejects confirmation with a wrong code and does NOT enable MFA', async () => {
      await request(app.getHttpServer())
        .post('/auth/mfa/enroll/confirm')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', await authHeader())
        .send({ code: '000000' })
        .expect(401);

      const res = await login(TENANT_A_SLUG, userEmail).expect(200);
      expect(res.body.mfaRequired).toBeUndefined();
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it('confirms enrollment with the correct code and returns one-time recovery codes', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/mfa/enroll/confirm')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', await authHeader())
        .send({ code: generateTotp(secret) })
        .expect(200);

      expect(res.body.recoveryCodes).toHaveLength(10);
      recoveryCodes = res.body.recoveryCodes;
    });
  });

  describe('login with MFA enabled', () => {
    it('returns a challenge, not tokens, once MFA is enabled', async () => {
      const res = await login(TENANT_A_SLUG, userEmail).expect(200);
      expect(res.body.mfaRequired).toBe(true);
      expect(res.body.challengeToken).toEqual(expect.any(String));
      expect(res.body.accessToken).toBeUndefined();
    });

    it('rejects a wrong TOTP code at the verify step', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code: '000000' })
        .expect(401);
    });

    it('a challenge token is tenant-scoped — presenting it under a DIFFERENT tenant Host never validates', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_B_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code: generateTotp(secret) })
        .expect(401);
    });

    it('accepts a correct TOTP code and issues a real session', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const verifyRes = await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code: generateTotp(secret) })
        .expect(200);

      expect(verifyRes.body.accessToken).toEqual(expect.any(String));
      expect(verifyRes.body.refreshToken).toEqual(expect.any(String));
      expect(verifyRes.body.roles).toEqual([SYSTEM_ROLES.TENANT_ADMIN]);
    });

    it('a challenge token can only be consumed once', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const body = { challengeToken: loginRes.body.challengeToken, code: generateTotp(secret) };
      await request(app.getHttpServer()).post('/auth/mfa/verify').set('Host', hostFor(TENANT_A_SLUG)).send(body).expect(200);
      await request(app.getHttpServer()).post('/auth/mfa/verify').set('Host', hostFor(TENANT_A_SLUG)).send(body).expect(401);
    });

    it('accepts a valid recovery code exactly once', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const code = recoveryCodes[0];

      await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code })
        .expect(200);

      // The recovery code is now consumed — a FRESH challenge with the
      // SAME code must fail even though the code was never re-typed wrong.
      const secondLoginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: secondLoginRes.body.challengeToken, code })
        .expect(401);
    });

    it('rate-limits repeated failed MFA verify attempts, separately from the login rate limit', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);

      let lastStatus = 0;
      for (let attempt = 0; attempt < 9; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- must be sequential to exercise the counter in order, same pattern auth-rbac.e2e-spec.ts's own login rate-limit test uses
        const res = await request(app.getHttpServer())
          .post('/auth/mfa/verify')
          .set('Host', hostFor(TENANT_A_SLUG))
          .send({ challengeToken: loginRes.body.challengeToken, code: '111111' });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);

      // Exhausted deliberately, to prove the limiter fires — reset so it
      // doesn't bleed into the disabling-MFA tests below, which reuse the
      // same user. Same "consumed on purpose, cleaned up explicitly"
      // posture auth-rbac.e2e-spec.ts's own rate-limit test takes for its
      // dedicated `rateLimitedEmail`.
      await redis.del(`ratelimit:mfa:${tenantAId}:${userId}`);
    });
  });

  describe('disabling MFA', () => {
    it('rejects disable with the wrong password even given a correct code', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const verifyRes = await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code: generateTotp(secret) })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/mfa/disable')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .send({ password: 'definitely-wrong', code: generateTotp(secret) })
        .expect(401);
    });

    it('disables MFA given the correct password + code, and login returns tokens directly again', async () => {
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const verifyRes = await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ challengeToken: loginRes.body.challengeToken, code: generateTotp(secret) })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/mfa/disable')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .send({ password: PASSWORD, code: generateTotp(secret) })
        .expect(204);

      const freshLogin = await login(TENANT_A_SLUG, userEmail).expect(200);
      expect(freshLogin.body.mfaRequired).toBeUndefined();
      expect(freshLogin.body.accessToken).toEqual(expect.any(String));
    });

    it('disabling MFA revoked every other live refresh session', async () => {
      // Re-enroll fresh (MFA was disabled above) to get a live session to revoke.
      const loginRes = await login(TENANT_A_SLUG, userEmail).expect(200);
      const staleRefreshToken = loginRes.body.refreshToken as string;

      const enrollRes = await request(app.getHttpServer())
        .post('/auth/mfa/enroll')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .expect(200);
      const newSecret = enrollRes.body.secret as string;
      const confirmRes = await request(app.getHttpServer())
        .post('/auth/mfa/enroll/confirm')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ code: generateTotp(newSecret) })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/mfa/disable')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ password: PASSWORD, code: (confirmRes.body.recoveryCodes as string[])[0] })
        .expect(204);

      // The refresh token minted by the login BEFORE disableMfa ran must no
      // longer work — disableMfa revokes every family, the same posture
      // changePassword already takes.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ refreshToken: staleRefreshToken })
        .expect(401);
    });
  });
});
