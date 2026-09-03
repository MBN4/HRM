/**
 * Proves tenant lifecycle management (step 4.1) end to end over real HTTP
 * — see docs/conventions/vendor-console.md → Tenant lifecycle:
 *   - Create (with and without an initial TENANT_ADMIN user), including
 *     RBAC seeding — the created admin can actually log in.
 *   - Duplicate slug rejected.
 *   - Suspend BLOCKS every request for that tenant (not just billing-gated
 *     — a genuine 403 before the transaction even opens); resume restores
 *     access.
 *   - Delete requires `confirmSlug` to match exactly, and is genuinely
 *     irreversible (cascades).
 *   - Usage metrics (seats vs. licensed cap, the platform-wide overview)
 *     read cheap, correct numbers.
 *   - Least-privilege: PLATFORM_SUPPORT can read but not suspend/delete.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_PREFIX = 'platform-tenants-test';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await cleanupTestPlatformAdmins();
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('platform tenant lifecycle + usage metrics (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let ownerToken: string;
  let supportToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    ownerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    supportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('create', () => {
    it('creates a tenant WITH an initial TENANT_ADMIN who can actually log in', async () => {
      const slug = `${SLUG_PREFIX}-with-admin`;
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'With Admin Co',
          slug,
          defaultCountryCode: 'US',
          hostingRegion: 'us-east-1',
          edition: 'PROFESSIONAL',
          initialAdminEmail: 'admin@with-admin.test',
          initialAdminName: 'The Admin',
          initialAdminPassword: 'a-genuinely-long-password-999',
        })
        .expect(201);

      expect(res.body).toMatchObject({ slug, edition: 'PROFESSIONAL', status: 'TRIAL' });

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Host', hostFor(slug))
        .send({ email: 'admin@with-admin.test', password: 'a-genuinely-long-password-999' })
        .expect(200);
      expect(login.body.roles).toContain('TENANT_ADMIN');
    });

    it('creates a tenant WITHOUT an initial admin — RBAC is still seeded', async () => {
      const slug = `${SLUG_PREFIX}-no-admin`;
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'No Admin Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(201);

      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: res.body.id } });
      const roleCount = await prisma.role.count({ where: { tenantId: tenant.id, isSystem: true } });
      expect(roleCount).toBeGreaterThanOrEqual(4);
      const userCount = await prisma.user.count({ where: { tenantId: tenant.id } });
      expect(userCount).toBe(0);
    });

    it('rejects a duplicate slug', async () => {
      const slug = `${SLUG_PREFIX}-dup`;
      await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Dup Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Dup Co Again', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(409);
    });

    it('PLATFORM_SUPPORT cannot create a tenant (TENANT_MANAGE is owner-only)', async () => {
      await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${supportToken}`)
        .send({ name: 'Nope Co', slug: `${SLUG_PREFIX}-nope`, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(403);
    });
  });

  describe('suspend blocks EVERY request; resume restores it', () => {
    it('a suspended tenant rejects an authenticated request, and even the login route itself', async () => {
      const slug = `${SLUG_PREFIX}-suspend`;
      const created = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Suspend Co',
          slug,
          defaultCountryCode: 'US',
          hostingRegion: 'us-east-1',
          initialAdminEmail: 'admin@suspend-co.test',
          initialAdminName: 'Admin',
          initialAdminPassword: 'another-long-password-888',
        })
        .expect(201);

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Host', hostFor(slug))
        .send({ email: 'admin@suspend-co.test', password: 'another-long-password-888' })
        .expect(200);
      const tenantUserToken = new JwtService({ secret: process.env.JWT_SECRET }).sign({
        sub: (await prisma.user.findFirstOrThrow({ where: { tenantId: created.body.id } })).id,
        tenantId: created.body.id,
      });
      void login;

      await request(app.getHttpServer())
        .post('/platform/tenants/' + created.body.id + '/suspend')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: 'non-payment' })
        .expect(201);

      // An ordinary authenticated request now gets 403, not the RBAC 401
      // it would get for a bad token — the tenant itself is blocked.
      await request(app.getHttpServer())
        .get('/tenancy/whoami')
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${tenantUserToken}`)
        .expect(403);

      // Even the LOGIN route itself is blocked — a suspended tenant's
      // users are blocked, full stop, not merely already-issued tokens.
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('Host', hostFor(slug))
        .send({ email: 'admin@suspend-co.test', password: 'another-long-password-888' })
        .expect(403);

      await request(app.getHttpServer())
        .post('/platform/tenants/' + created.body.id + '/resume')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201);

      await request(app.getHttpServer())
        .get('/tenancy/whoami')
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${tenantUserToken}`)
        .expect(200);
    });

    it('PLATFORM_SUPPORT cannot suspend a tenant', async () => {
      const slug = `${SLUG_PREFIX}-support-cant-suspend`;
      const created = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'S Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/platform/tenants/${created.body.id}/suspend`)
        .set('Authorization', `Bearer ${supportToken}`)
        .send({})
        .expect(403);
    });
  });

  describe('delete — irreversible, confirm-by-slug', () => {
    it('rejects a mismatched confirmSlug, then succeeds with the correct one', async () => {
      const slug = `${SLUG_PREFIX}-delete-me`;
      const created = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Delete Me Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/platform/tenants/${created.body.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ confirmSlug: 'totally-wrong-slug' })
        .expect(400);

      await request(app.getHttpServer())
        .delete(`/platform/tenants/${created.body.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ confirmSlug: slug })
        .expect(204);

      const gone = await prisma.tenant.findUnique({ where: { id: created.body.id } });
      expect(gone).toBeNull();
    });

    it('PLATFORM_SUPPORT cannot delete a tenant (TENANT_DELETE is owner-only, separate from TENANT_MANAGE)', async () => {
      const slug = `${SLUG_PREFIX}-support-cant-delete`;
      const created = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'D Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/platform/tenants/${created.body.id}`)
        .set('Authorization', `Bearer ${supportToken}`)
        .send({ confirmSlug: slug })
        .expect(403);
    });
  });

  describe('usage metrics — cheap reads, correct numbers', () => {
    it('reports active employee count against the licensed seat cap, and the platform-wide overview', async () => {
      const slug = `${SLUG_PREFIX}-usage`;
      const created = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Usage Co', slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1', edition: 'STARTER' })
        .expect(201);
      const tenantId = created.body.id as string;

      const branch = await prisma.branch.create({
        data: { tenantId, name: 'HQ', countryCode: 'US', timezone: 'America/New_York' },
      });
      await prisma.subscription.create({ data: { tenantId, edition: 'STARTER', status: 'ACTIVE', seatCap: 1 } });
      await prisma.employee.create({
        data: {
          tenantId,
          branchId: branch.id,
          employeeCode: 'E1',
          firstName: 'One',
          lastName: 'Employee',
          employmentType: 'FULL_TIME',
          joinDate: new Date(),
          status: 'ACTIVE',
        },
      });
      await prisma.employee.create({
        data: {
          tenantId,
          branchId: branch.id,
          employeeCode: 'E2',
          firstName: 'Two',
          lastName: 'Employee',
          employmentType: 'FULL_TIME',
          joinDate: new Date(),
          status: 'ACTIVE',
        },
      });

      const metrics = await request(app.getHttpServer())
        .get(`/platform/usage/${tenantId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(metrics.body.seats).toMatchObject({ activeEmployees: 2, licensedSeatCap: 1, overCap: true });
      expect(metrics.body.apiVolume.currentWindowLimit).toBeGreaterThan(0);

      const overview = await request(app.getHttpServer())
        .get('/platform/usage/overview')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(overview.body.totalTenants).toBeGreaterThanOrEqual(1);
      expect(overview.body.totalActiveEmployees).toBeGreaterThanOrEqual(2);
    });
  });
});
