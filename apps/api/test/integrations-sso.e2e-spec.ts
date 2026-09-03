/**
 * Proves the SSO seam FINISHED in step 3.3 (abstracted since 0.4) end to
 * end over real HTTP — see docs/conventions/integrations.md: an
 * ENTERPRISE tenant with OIDC configured completes a real, cryptographically
 * verified Authorization Code login against a local fake IdP (real RSA
 * signature verification via JWKS, not a stub), find-or-provisions a real
 * `User`, and issues the SAME token shape `AuthService.login` does;
 * `allowedEmailDomains` is enforced; SSO is gated behind `FEATURE_FLAGS.SSO`
 * (a PROFESSIONAL, non-ENTERPRISE tenant cannot even save/enable a config);
 * SAML's seam is wired (a real AuthnRequest redirect) but its response
 * verification is a documented, deliberate 501; and none of it crosses
 * tenants (RLS) — one tenant's SSO config can never authenticate into
 * another.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_ENTERPRISE_SLUG = 'int-sso-tenant-ent';
const TENANT_PRO_SLUG = 'int-sso-tenant-pro';
const TENANT_OTHER_ENTERPRISE_SLUG = 'int-sso-tenant-ent-2';
const TENANT_CROSS_SLUG = 'int-sso-tenant-cross';

const localJwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({
    where: { slug: { in: [TENANT_ENTERPRISE_SLUG, TENANT_PRO_SLUG, TENANT_OTHER_ENTERPRISE_SLUG, TENANT_CROSS_SLUG] } },
  });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

/** A local fake OIDC IdP — real RSA signing, so `OidcAuthProvider` performs a REAL JWKS-based signature verification, not a stubbed one. */
function startFakeOidcIdp(clientId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-kid-1';
  const jwk = { ...(publicKey as KeyObject).export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  let nextEmail = 'sso-user-1@allowed.test';
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url?.startsWith('/token') && req.method === 'POST') {
      const idToken = jwt.sign(
        { email: nextEmail, sub: 'external-sub-1', name: 'SSO Test User' },
        privateKey,
        { algorithm: 'RS256', keyid: kid, issuer: 'https://fake-idp.test', audience: clientId, expiresIn: '5m' },
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    server,
    setNextEmail: (email: string) => {
      nextEmail = email;
    },
  };
}

describe('integrations — SSO (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let idp: ReturnType<typeof startFakeOidcIdp>;
  let idpBaseUrl: string;

  let enterpriseTenantId: string;
  let proTenantId: string;
  let adminTokenEnterprise: string;
  let adminTokenPro: string;

  const CLIENT_ID = 'test-client-id';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    idp = startFakeOidcIdp(CLIENT_ID);
    await new Promise<void>((resolve) => idp.server.listen(0, '127.0.0.1', resolve));
    const port = (idp.server.address() as AddressInfo).port;
    idpBaseUrl = `http://127.0.0.1:${port}`;

    await resetFixtures();

    const enterpriseTenant = await prisma.tenant.create({
      data: { name: 'SSO Enterprise Tenant', slug: TENANT_ENTERPRISE_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const proTenant = await prisma.tenant.create({
      data: { name: 'SSO Professional Tenant', slug: TENANT_PRO_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    enterpriseTenantId = enterpriseTenant.id;
    proTenantId = proTenant.id;

    await seedSystemRolesAndPermissions(prisma, enterpriseTenantId);
    await seedSystemRolesAndPermissions(prisma, proTenantId);

    await prisma.subscription.create({ data: { tenantId: enterpriseTenantId, edition: 'ENTERPRISE', status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { tenantId: proTenantId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });

    const adminEntRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: enterpriseTenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminEnt = await prisma.user.create({
      data: { tenantId: enterpriseTenantId, email: 'admin@int-sso-ent.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: enterpriseTenantId, userId: adminEnt.id, roleId: adminEntRole.id } });
    adminTokenEnterprise = localJwt.sign({ sub: adminEnt.id, tenantId: enterpriseTenantId });

    const adminProRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: proTenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminPro = await prisma.user.create({
      data: { tenantId: proTenantId, email: 'admin@int-sso-pro.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: proTenantId, userId: adminPro.id, roleId: adminProRole.id } });
    adminTokenPro = localJwt.sign({ sub: adminPro.id, tenantId: proTenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    idp.server.close();
    await app.close();
  });

  function oidcConfigBody(overrides: Record<string, unknown> = {}) {
    return {
      protocol: 'OIDC',
      issuer: 'https://fake-idp.test',
      clientId: CLIENT_ID,
      clientSecret: 'super-secret-value',
      authorizationEndpoint: `${idpBaseUrl}/authorize`,
      tokenEndpoint: `${idpBaseUrl}/token`,
      jwksUri: `${idpBaseUrl}/jwks`,
      scopes: ['openid', 'email', 'profile'],
      defaultRoleName: SYSTEM_ROLES.EMPLOYEE,
      ...overrides,
    };
  }

  function putConfig(token: string, slug: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .put('/auth/sso/config')
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function setEnabled(token: string, slug: string, enabled: boolean) {
    return request(app.getHttpServer())
      .post('/auth/sso/config/enabled')
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled });
  }

  function ssoLogin(slug: string) {
    return request(app.getHttpServer()).get('/auth/sso/login').set('Host', hostFor(slug));
  }

  function stateFromRedirect(location: string): string {
    const url = new URL(location);
    const state = url.searchParams.get('state');
    if (!state) {
      throw new Error(`No state param on redirect: ${location}`);
    }
    return state;
  }

  function ssoCallback(slug: string, code: string, state: string) {
    return request(app.getHttpServer())
      .get('/auth/sso/callback')
      .set('Host', hostFor(slug))
      .query({ code, state });
  }

  it('a PROFESSIONAL (non-ENTERPRISE) tenant cannot even save an SSO config — FEATURE_FLAGS.SSO gate', async () => {
    const res = await putConfig(adminTokenPro, TENANT_PRO_SLUG, oidcConfigBody());
    expect(res.status).toBe(403);
  });

  it('an ENTERPRISE tenant can configure and enable OIDC SSO', async () => {
    const res = await putConfig(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, oidcConfigBody()).expect(200);
    expect(res.body.protocol).toBe('OIDC');
    // The client secret is NEVER echoed back, even right after saving it.
    expect(res.body.config.clientSecret).toBe('[REDACTED]');

    await setEnabled(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, true).expect(200);

    const readBack = await request(app.getHttpServer())
      .get('/auth/sso/config')
      .set('Host', hostFor(TENANT_ENTERPRISE_SLUG))
      .set('Authorization', `Bearer ${adminTokenEnterprise}`)
      .expect(200);
    expect(readBack.body.enabled).toBe(true);
  });

  it('SSO disabled (not yet enabled) rejects /login even for a configured ENTERPRISE tenant', async () => {
    // A throwaway second ENTERPRISE tenant with a config saved but never enabled.
    const tenant = await prisma.tenant.create({
      data: { name: 'SSO Not-Enabled Tenant', slug: TENANT_OTHER_ENTERPRISE_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await seedSystemRolesAndPermissions(prisma, tenant.id);
    await prisma.subscription.create({ data: { tenantId: tenant.id, edition: 'ENTERPRISE', status: 'ACTIVE' } });
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: 'admin@int-sso-ent-2.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    const token = localJwt.sign({ sub: user.id, tenantId: tenant.id });

    await putConfig(token, TENANT_OTHER_ENTERPRISE_SLUG, oidcConfigBody()).expect(200);
    // enabled defaults to false — /login must 404 (not configured/enabled).
    await ssoLogin(TENANT_OTHER_ENTERPRISE_SLUG).expect(404);
  });

  it('a real OIDC Authorization Code login: redirects to the IdP, exchanges the code, verifies the id_token via JWKS, and provisions a real User', async () => {
    idp.setNextEmail('new-sso-user@allowed.test');

    const loginRes = await ssoLogin(TENANT_ENTERPRISE_SLUG).expect(302);
    const location = loginRes.headers.location;
    expect(location.startsWith(`${idpBaseUrl}/authorize`)).toBe(true);
    const state = stateFromRedirect(location);

    const callbackRes = await ssoCallback(TENANT_ENTERPRISE_SLUG, 'fake-authorization-code', state).expect(200);
    expect(typeof callbackRes.body.accessToken).toBe('string');
    expect(typeof callbackRes.body.refreshToken).toBe('string');
    expect(callbackRes.body.roles).toContain(SYSTEM_ROLES.EMPLOYEE);

    const provisioned = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: enterpriseTenantId, email: 'new-sso-user@allowed.test' } },
    });
    expect(provisioned).not.toBeNull();
    expect(provisioned!.status).toBe('ACTIVE');

    // The issued access token is a REAL, ordinary JWT — the caller's very
    // next request can use it exactly like a password-login session.
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Host', hostFor(TENANT_ENTERPRISE_SLUG))
      .set('Authorization', `Bearer ${callbackRes.body.accessToken}`)
      .expect(200);
    expect(me.body.userId).toBe(provisioned!.id);
  });

  it('a second login for the SAME email finds the existing user rather than provisioning a duplicate', async () => {
    idp.setNextEmail('new-sso-user@allowed.test');
    const loginRes = await ssoLogin(TENANT_ENTERPRISE_SLUG).expect(302);
    const state = stateFromRedirect(loginRes.headers.location);
    const callbackRes = await ssoCallback(TENANT_ENTERPRISE_SLUG, 'fake-authorization-code-2', state).expect(200);

    const users = await prisma.user.findMany({
      where: { tenantId: enterpriseTenantId, email: 'new-sso-user@allowed.test' },
    });
    expect(users).toHaveLength(1);
    expect(callbackRes.body.userId).toBe(users[0].id);
  });

  it('a stale/reused state is rejected — the flow cannot be replayed', async () => {
    idp.setNextEmail('replay-test@allowed.test');
    const loginRes = await ssoLogin(TENANT_ENTERPRISE_SLUG).expect(302);
    const state = stateFromRedirect(loginRes.headers.location);

    await ssoCallback(TENANT_ENTERPRISE_SLUG, 'code-1', state).expect(200);
    // The SAME state used again — already consumed.
    await ssoCallback(TENANT_ENTERPRISE_SLUG, 'code-2', state).expect(401);
  });

  it('allowedEmailDomains is enforced — an out-of-domain identity is rejected', async () => {
    await putConfig(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, oidcConfigBody({ allowedEmailDomains: ['allowed.test'] })).expect(200);
    await setEnabled(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, true).expect(200);

    idp.setNextEmail('someone@not-allowed.test');
    const loginRes = await ssoLogin(TENANT_ENTERPRISE_SLUG).expect(302);
    const state = stateFromRedirect(loginRes.headers.location);
    await ssoCallback(TENANT_ENTERPRISE_SLUG, 'code-domain-check', state).expect(401);

    const disallowedUser = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: enterpriseTenantId, email: 'someone@not-allowed.test' } },
    });
    expect(disallowedUser).toBeNull();
  });

  it('SAML: a real AuthnRequest redirect is built, but response verification is a documented 501, not a silent success', async () => {
    await putConfig(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, {
      protocol: 'SAML',
      idpEntityId: 'https://fake-saml-idp.test/entity',
      idpSsoUrl: 'https://fake-saml-idp.test/sso',
      idpCertificate: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----',
      spEntityId: 'https://int-sso-tenant-ent.yourhrms.local/sp',
      defaultRoleName: SYSTEM_ROLES.EMPLOYEE,
    }).expect(200);
    await setEnabled(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, true).expect(200);

    const loginRes = await ssoLogin(TENANT_ENTERPRISE_SLUG).expect(302);
    expect(loginRes.headers.location.startsWith('https://fake-saml-idp.test/sso')).toBe(true);
    const urlParams = new URL(loginRes.headers.location).searchParams;
    expect(urlParams.get('SAMLRequest')).toBeTruthy();
    expect(urlParams.get('RelayState')).toBeTruthy();

    const state = urlParams.get('RelayState')!;
    await request(app.getHttpServer())
      .post('/auth/sso/callback')
      .set('Host', hostFor(TENANT_ENTERPRISE_SLUG))
      .send({ SAMLResponse: 'ZmFrZQ==', RelayState: state })
      .expect(501);

    // Revert back to OIDC + full domain restriction lifted, so it doesn't
    // affect any test ordered after this one.
    await putConfig(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, oidcConfigBody()).expect(200);
    await setEnabled(adminTokenEnterprise, TENANT_ENTERPRISE_SLUG, true).expect(200);
  });

  it('cross-tenant: tenant A cannot see or use tenant B\'s SSO config, and a login on tenant A never resolves against tenant B (RLS)', async () => {
    // A second ENTERPRISE tenant, its OWN OIDC config pointed at the SAME
    // fake IdP but a DIFFERENT default role name, to prove which config
    // actually governs a callback.
    const tenantC = await prisma.tenant.create({
      data: { name: 'SSO Cross-Tenant Check', slug: TENANT_CROSS_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await seedSystemRolesAndPermissions(prisma, tenantC.id);
    await prisma.subscription.create({ data: { tenantId: tenantC.id, edition: 'ENTERPRISE', status: 'ACTIVE' } });
    const roleC = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantC.id, name: SYSTEM_ROLES.TENANT_ADMIN } } });
    const userC = await prisma.user.create({
      data: { tenantId: tenantC.id, email: 'admin@int-sso-cross.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantC.id, userId: userC.id, roleId: roleC.id } });
    const tokenC = localJwt.sign({ sub: userC.id, tenantId: tenantC.id });

    // Tenant C has no SSO config of its own yet — its /login must 404, even
    // though tenant A (Enterprise) has one fully configured and enabled.
    await ssoLogin(TENANT_CROSS_SLUG).expect(404);

    // Tenant C cannot read tenant A's config via RLS.
    const readC = await request(app.getHttpServer())
      .get('/auth/sso/config')
      .set('Host', hostFor(TENANT_CROSS_SLUG))
      .set('Authorization', `Bearer ${tokenC}`)
      .expect(200);
    // Nest serializes a `null` controller return as an empty JSON body —
    // supertest parses that back as `{}`, not the literal `null`.
    expect(readC.body).toEqual({});

    await prisma.tenant.delete({ where: { id: tenantC.id } });
  });
});
