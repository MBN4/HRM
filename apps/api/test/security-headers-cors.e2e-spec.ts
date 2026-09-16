/**
 * Proves step 6.2's secure-headers + CORS-allow-list wiring
 * (`configureSecurity`, `CorsOriginService`) end to end over real HTTP —
 * see docs/conventions/security-hardening.md:
 *   - helmet's secure headers are actually present on a real response.
 *   - CORS allows TENANT_BASE_DOMAIN and its subdomains, an EXPLICIT
 *     `CORS_ADDITIONAL_ORIGINS` entry, and a tenant's VERIFIED custom
 *     domain — but rejects an unrelated origin and an UNVERIFIED custom
 *     domain (the same gate `TenantResolutionService.resolveByCustomDomain`
 *     already enforces for tenant resolution itself).
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.CORS_ADDITIONAL_ORIGINS = 'https://explicit-allowed.example';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { configureSecurity } from '../src/security/configure-security';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'cors-test-tenant';
const VERIFIED_DOMAIN = 'hr.cors-verified.example';
const UNVERIFIED_DOMAIN = 'hr.cors-unverified.example';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('security headers + CORS allow-list (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'CORS Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: tenant.id, domain: VERIFIED_DOMAIN, verificationStatus: 'VERIFIED', verificationToken: 'tok-verified' },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: tenant.id, domain: UNVERIFIED_DOMAIN, verificationStatus: 'PENDING_VERIFICATION', verificationToken: 'tok-unverified' },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('secure headers (helmet)', () => {
    it('sets HSTS, X-Content-Type-Options, X-Frame-Options, and a real CSP on every response', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    });
  });

  describe('CORS allow-list', () => {
    it('allows a TENANT_BASE_DOMAIN subdomain origin', async () => {
      const origin = `https://${TENANT_SLUG}.${BASE_DOMAIN}`;
      const res = await request(app.getHttpServer()).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });

    it('allows an explicit CORS_ADDITIONAL_ORIGINS entry', async () => {
      const res = await request(app.getHttpServer()).get('/health').set('Origin', 'https://explicit-allowed.example');
      expect(res.headers['access-control-allow-origin']).toBe('https://explicit-allowed.example');
    });

    it('allows a VERIFIED tenant custom domain', async () => {
      const origin = `https://${VERIFIED_DOMAIN}`;
      const res = await request(app.getHttpServer()).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });

    it('rejects an UNVERIFIED tenant custom domain — same gate tenant resolution itself enforces', async () => {
      const res = await request(app.getHttpServer()).get('/health').set('Origin', `https://${UNVERIFIED_DOMAIN}`);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects a completely unrelated origin', async () => {
      const res = await request(app.getHttpServer()).get('/health').set('Origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
