/**
 * Phase 6.3 (edge security) — proves `CacheControlInterceptor` end to end
 * over real HTTP: see docs/conventions/edge-security.md → CDN. The stakes
 * this test exists for are stated plainly in that doc — a caching mistake
 * in the "too permissive" direction is a cross-tenant DATA LEAK (a shared/
 * CDN cache serving tenant A's authenticated response to tenant B's next
 * visitor), not merely a staleness bug, so this is a security regression
 * test, not a performance one.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { configureSecurity } from '../src/security/configure-security';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'edge-cache-control-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('edge cache-control correctness (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let adminToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Edge Cache Control Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const admin = await prisma.user.create({
      data: { tenantId, email: `admin@${TENANT_SLUG}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: admin.id, roleId: adminRole.id } });
    adminToken = jwt.sign({ sub: admin.id, tenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('a public, CDN-cacheable careers listing carries a real public Cache-Control', async () => {
    const res = await request(app.getHttpServer()).get('/careers/postings').set('Host', hostFor(TENANT_SLUG)).expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  });

  it('a 404 from the SAME public route still carries a cacheable-but-public header, never no-store (not a sensitivity concern — no PII in a "no such posting" response)', async () => {
    const res = await request(app.getHttpServer())
      .get('/careers/postings/no-such-slug-at-all')
      .set('Host', hostFor(TENANT_SLUG))
      .expect(404);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  });

  it('an authenticated, tenant-scoped read is marked no-store by DEFAULT — the anti-leak posture', async () => {
    const res = await request(app.getHttpServer())
      .get('/custom-fields/definitions/Employee')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('an unauthenticated request to a protected route (401) is ALSO marked no-store, never left uncached-by-omission', async () => {
    const res = await request(app.getHttpServer())
      .get('/custom-fields/definitions/Employee')
      .set('Host', hostFor(TENANT_SLUG))
      .expect(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
