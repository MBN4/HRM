/**
 * Proves the vendor super-admin console's own login surface end to end
 * over real HTTP (step 4.1) — see docs/conventions/vendor-console.md:
 *   - MFA is truly MANDATORY: a fresh admin cannot obtain a session from a
 *     password alone; the full login -> enroll -> confirm -> session state
 *     machine, and the (now-enrolled) login -> challenge -> verify path.
 *   - No user enumeration (same generic failure for a wrong password or an
 *     unknown email).
 *   - Recovery codes work once each; a wrong TOTP code is rejected.
 *   - Refresh rotation + reuse detection (same shape as tenant auth, 0.4).
 *   - THE CRITICAL AUTHORIZATION BOUNDARY: a real tenant user's own access
 *     token — even a perfectly valid one — can NEVER reach a platform
 *     route, and neither can an unauthenticated caller.
 *   - Least-privilege: PLATFORM_SUPPORT cannot perform an owner-only
 *     action (creating another platform admin) that PLATFORM_OWNER can.
 *   - A suspended platform admin's existing token stops working immediately.
 *
 * `PLATFORM_MODE_ENABLED` forced on before the Nest app is compiled — same
 * pattern every other e2e suite touching a `@PlatformRoute()` already uses.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { EncryptionService } from '../src/common/encryption/encryption.service';
import { EnvSecretsProvider } from '../src/common/encryption/key-provider/env-secrets.provider';
import { generateTotp } from '../src/platform/auth/totp.util';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const encryption = new EncryptionService(new EnvSecretsProvider(new ConfigService({ FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY })));

const ARGON2ID = 2;
const TENANT_SLUG = 'platform-auth-tenant';
const ADMIN_EMAIL = 'fresh-owner@platform-auth.test';
const ADMIN_PASSWORD = 'a-genuinely-long-password-123!';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
  await prisma.platformAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL] } } });
  await cleanupTestPlatformAdmins();
}

describe('platform auth — mandatory MFA + the authorization boundary (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let tenantUserToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const hashedPassword = await hash(ADMIN_PASSWORD, { algorithm: ARGON2ID });
    await prisma.platformAdmin.create({
      data: { email: ADMIN_EMAIL, name: 'Fresh Owner', hashedPassword, role: 'PLATFORM_OWNER' },
    });

    // A real tenant + a real tenant user, for the authorization-boundary
    // proof below — a perfectly ordinary, validly-issued tenant token.
    const tenant = await prisma.tenant.create({
      data: { name: 'Platform Auth Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'admin@platform-auth-tenant.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    tenantUserToken = new JwtService({ secret: process.env.JWT_SECRET }).sign({ sub: user.id, tenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function decryptMfaSecret(encrypted: string): string {
    return encryption.decrypt(encrypted);
  }

  async function loginAndVerify(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
    const login = await request(app.getHttpServer()).post('/platform/auth/login').send({ email, password }).expect(200);
    const admin = await prisma.platformAdmin.findUniqueOrThrow({ where: { email } });
    const secret = decryptMfaSecret(admin.mfaSecretEncrypted!);
    const verify = await request(app.getHttpServer())
      .post('/platform/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code: generateTotp(secret) })
      .expect(200);
    return { accessToken: verify.body.accessToken, refreshToken: verify.body.refreshToken };
  }

  describe('mandatory MFA — the full state machine', () => {
    it('a password-only login for a fresh admin returns mfaSetupRequired, never a session', async () => {
      const res = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
        .expect(200);

      expect(res.body).toMatchObject({ mfaSetupRequired: true });
      expect(res.body.accessToken).toBeUndefined();
      expect(typeof res.body.enrollmentToken).toBe('string');
    });

    it('completes enrollment (secret -> TOTP code -> confirm) and receives a real session + one-time recovery codes', async () => {
      const login = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
        .expect(200);
      const enrollmentToken = login.body.enrollmentToken as string;

      const enroll = await request(app.getHttpServer())
        .post('/platform/auth/mfa/enroll')
        .send({ enrollmentToken })
        .expect(200);
      expect(typeof enroll.body.secret).toBe('string');
      expect(enroll.body.otpauthUrl).toContain('otpauth://totp/');

      const code = generateTotp(enroll.body.secret);
      const confirm = await request(app.getHttpServer())
        .post('/platform/auth/mfa/enroll/confirm')
        .send({ enrollmentToken, code })
        .expect(200);

      expect(typeof confirm.body.accessToken).toBe('string');
      expect(typeof confirm.body.refreshToken).toBe('string');
      expect(confirm.body.role).toBe('PLATFORM_OWNER');
      expect(Array.isArray(confirm.body.recoveryCodes)).toBe(true);
      expect(confirm.body.recoveryCodes).toHaveLength(10);

      const me = await request(app.getHttpServer())
        .get('/platform/auth/me')
        .set('Authorization', `Bearer ${confirm.body.accessToken}`)
        .expect(200);
      expect(me.body.role).toBe('PLATFORM_OWNER');
    });

    it('an ALREADY-enrolled admin login now returns mfaRequired, and a correct TOTP code completes it', async () => {
      const login = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
        .expect(200);
      expect(login.body).toMatchObject({ mfaRequired: true });
      expect(typeof login.body.challengeToken).toBe('string');

      const admin = await prisma.platformAdmin.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
      const code = generateTotp(decryptMfaSecret(admin.mfaSecretEncrypted!));

      const verify = await request(app.getHttpServer())
        .post('/platform/auth/mfa/verify')
        .send({ challengeToken: login.body.challengeToken, code })
        .expect(200);
      expect(typeof verify.body.accessToken).toBe('string');
    });

    it('rejects a wrong password with the SAME generic message an unknown email gets (no enumeration)', async () => {
      const wrongPassword = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'totally-wrong-password' })
        .expect(401);
      const unknownEmail = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: 'nobody@platform-auth.test', password: 'whatever-123456' })
        .expect(401);
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('rejects a wrong MFA code, and a recovery code works exactly once', async () => {
      const login = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/platform/auth/mfa/verify')
        .send({ challengeToken: login.body.challengeToken, code: '000000' })
        .expect(401);

      // A fresh, independent admin — we need the recovery codes'
      // PLAINTEXT (only visible once, at enrollment) for this proof, and
      // ADMIN_EMAIL's own set was already returned to an earlier test.
      const recoveryAdminEmail = `recovery-${Date.now()}@platform-auth.test`;
      const recoveryPassword = 'another-long-password-456!';
      const recoveryHashed = await hash(recoveryPassword, { algorithm: ARGON2ID });
      await prisma.platformAdmin.create({
        data: { email: recoveryAdminEmail, name: 'Recovery Test', hashedPassword: recoveryHashed, role: 'PLATFORM_OWNER' },
      });
      const rLogin = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: recoveryAdminEmail, password: recoveryPassword })
        .expect(200);
      const rEnroll = await request(app.getHttpServer())
        .post('/platform/auth/mfa/enroll')
        .send({ enrollmentToken: rLogin.body.enrollmentToken })
        .expect(200);
      const rConfirm = await request(app.getHttpServer())
        .post('/platform/auth/mfa/enroll/confirm')
        .send({ enrollmentToken: rLogin.body.enrollmentToken, code: generateTotp(rEnroll.body.secret) })
        .expect(200);
      const recoveryCode = rConfirm.body.recoveryCodes[0] as string;

      const rLogin2 = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: recoveryAdminEmail, password: recoveryPassword })
        .expect(200);
      await request(app.getHttpServer())
        .post('/platform/auth/mfa/verify')
        .send({ challengeToken: rLogin2.body.challengeToken, code: recoveryCode })
        .expect(200);

      // The SAME recovery code cannot be used a second time.
      const rLogin3 = await request(app.getHttpServer())
        .post('/platform/auth/login')
        .send({ email: recoveryAdminEmail, password: recoveryPassword })
        .expect(200);
      await request(app.getHttpServer())
        .post('/platform/auth/mfa/verify')
        .send({ challengeToken: rLogin3.body.challengeToken, code: recoveryCode })
        .expect(401);
    });
  });

  describe('refresh rotation + reuse detection (same shape as tenant auth)', () => {
    it('rotates on refresh, and presenting the SAME rotated-away token again is rejected', async () => {
      const { refreshToken } = await loginAndVerify(ADMIN_EMAIL, ADMIN_PASSWORD);

      const rotated = await request(app.getHttpServer()).post('/platform/auth/refresh').send({ refreshToken }).expect(200);
      expect(rotated.body.refreshToken).not.toBe(refreshToken);

      // Reusing the original (now rotated-away) token is rejected.
      await request(app.getHttpServer()).post('/platform/auth/refresh').send({ refreshToken }).expect(401);
      // ...and reuse revokes the WHOLE family — the just-rotated token is dead too.
      await request(app.getHttpServer())
        .post('/platform/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
    });

    it('logout revokes the refresh token', async () => {
      const { accessToken, refreshToken } = await loginAndVerify(ADMIN_EMAIL, ADMIN_PASSWORD);

      await request(app.getHttpServer())
        .post('/platform/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(204);

      await request(app.getHttpServer()).post('/platform/auth/refresh').send({ refreshToken }).expect(401);
    });
  });

  describe('THE CRITICAL AUTHORIZATION BOUNDARY', () => {
    it('a normal tenant user cannot reach ANY platform route — not with a valid tenant token, not with none at all', async () => {
      await request(app.getHttpServer())
        .get('/platform/tenants')
        .set('Authorization', `Bearer ${tenantUserToken}`)
        .expect(401);

      await request(app.getHttpServer()).get('/platform/tenants').expect(401);

      await request(app.getHttpServer())
        .post('/platform/country-packs')
        .set('Authorization', `Bearer ${tenantUserToken}`)
        .send({ countryCode: 'ZZ', config: {} })
        .expect(401);
    });

    it('a garbage/malformed bearer token is rejected the same way', async () => {
      await request(app.getHttpServer())
        .get('/platform/tenants')
        .set('Authorization', 'Bearer not-a-real-token-at-all')
        .expect(401);
    });
  });

  describe('least-privilege platform roles', () => {
    it('PLATFORM_SUPPORT can read tenants but cannot create a platform admin (owner-only)', async () => {
      const support = await createTestPlatformAdmin('PLATFORM_SUPPORT');

      await request(app.getHttpServer())
        .get('/platform/tenants')
        .set('Authorization', `Bearer ${support.token}`)
        .expect(200);

      await request(app.getHttpServer())
        .get('/platform/usage/overview')
        .set('Authorization', `Bearer ${support.token}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/platform/admins')
        .set('Authorization', `Bearer ${support.token}`)
        .send({ email: 'nope@platform-auth.test', name: 'Nope', password: 'irrelevant-password-1', role: 'PLATFORM_SUPPORT' })
        .expect(403);

      await request(app.getHttpServer())
        .post('/platform/country-packs')
        .set('Authorization', `Bearer ${support.token}`)
        .send({ countryCode: 'ZZ', config: {} })
        .expect(403);
    });

    it('PLATFORM_OWNER can create another platform admin', async () => {
      const owner = await createTestPlatformAdmin('PLATFORM_OWNER');
      const res = await request(app.getHttpServer())
        .post('/platform/admins')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: `new-owner-${Date.now()}@platform-auth.test`, name: 'New Owner', password: 'a-brand-new-password-1', role: 'PLATFORM_SUPPORT' })
        .expect(201);
      expect(res.body.mfaEnabled).toBe(false);
    });
  });

  describe('a suspended platform admin loses access immediately', () => {
    it('a previously-valid access token stops authenticating the instant status flips to SUSPENDED', async () => {
      const admin = await createTestPlatformAdmin('PLATFORM_OWNER');
      await request(app.getHttpServer())
        .get('/platform/tenants')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      await prisma.platformAdmin.update({ where: { id: admin.id }, data: { status: 'SUSPENDED' } });

      await request(app.getHttpServer())
        .get('/platform/tenants')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(401);
    });
  });
});
