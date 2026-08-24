/**
 * Proves the 0.3 tenant-resolution layer end to end over real HTTP, against
 * the local Postgres instance — not just that `withTenantContext` works
 * (that's already covered in packages/db), but that resolving a request's
 * tenant from its subdomain/custom-domain/header and opening the request's
 * transaction from `TenantScopeInterceptor` actually keeps RLS enforced for
 * the whole request lifecycle.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { prisma } from '@hrm/db';
import { AppModule } from '../src/app.module';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';

const TENANT_A_SLUG = 'res-test-a';
const TENANT_B_SLUG = 'res-test-b';
const CUSTOM_DOMAIN = 'custom-a.example.test';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

describe('tenant resolution (e2e)', () => {
  let app: INestApplication;
  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;
  let branchBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: {
        name: 'Resolution Test Tenant A',
        slug: TENANT_A_SLUG,
        defaultCountryCode: 'US',
        hostingRegion: 'us-east-1',
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: 'Resolution Test Tenant B',
        slug: TENANT_B_SLUG,
        defaultCountryCode: 'QA',
        hostingRegion: 'me-south-1',
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Tenant A Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'Tenant B Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchAId = branchA.id;
    branchBId = branchB.id;

    await prisma.tenantDomain.create({ data: { tenantId: tenantAId, domain: CUSTOM_DOMAIN } });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await app.close();
  });

  it('resolves tenant A via subdomain and cannot see tenant B\'s rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/branches')
      .set('Host', `${TENANT_A_SLUG}.${BASE_DOMAIN}`)
      .expect(200);

    expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchAId]);
    expect(res.body.some((b: { id: string }) => b.id === branchBId)).toBe(false);
  });

  it('resolves tenant B via subdomain and cannot see tenant A\'s rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/branches')
      .set('Host', `${TENANT_B_SLUG}.${BASE_DOMAIN}`)
      .expect(200);

    expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchBId]);
  });

  it('resolves tenant A via the explicit header and cannot see tenant B\'s rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/branches')
      .set('Host', '127.0.0.1')
      .set('x-tenant-id', tenantAId)
      .expect(200);

    expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchAId]);
    expect(res.body.some((b: { id: string }) => b.id === branchBId)).toBe(false);
  });

  it('resolves tenant A via the header using its slug too', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/branches')
      .set('Host', '127.0.0.1')
      .set('x-tenant-id', TENANT_A_SLUG)
      .expect(200);

    expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchAId]);
  });

  it('resolves tenant A via a mapped custom domain', async () => {
    const res = await request(app.getHttpServer()).get('/tenancy/branches').set('Host', CUSTOM_DOMAIN).expect(200);

    expect(res.body.map((b: { id: string }) => b.id)).toEqual([branchAId]);
  });

  it('rejects a request with no resolvable tenant', async () => {
    await request(app.getHttpServer())
      .get('/tenancy/branches')
      .set('Host', `no-such-tenant.${BASE_DOMAIN}`)
      .expect(401);
  });

  it('lets a public route through with no tenant at all', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Host', `no-such-tenant.${BASE_DOMAIN}`)
      .expect(200);

    expect(res.body).toEqual({ status: 'ok', service: 'hrm' });
  });

  it('proves RLS is active through the HTTP layer: a crafted query param cannot leak tenant B\'s rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/branches')
      .query({ tenantId: tenantBId })
      .set('Host', `${TENANT_A_SLUG}.${BASE_DOMAIN}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('exposes the resolved context shape via @CurrentTenant(), with branch/user/roles nullable', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenancy/whoami')
      .set('Host', `${TENANT_A_SLUG}.${BASE_DOMAIN}`)
      .expect(200);

    expect(res.body).toEqual({
      tenantId: tenantAId,
      branchId: null,
      userId: null,
      roles: null,
      platform: false,
    });
  });

  it('rejects a platform route while platform mode is disabled by default', async () => {
    await request(app.getHttpServer()).get('/platform/ping').expect(403);
  });
});
