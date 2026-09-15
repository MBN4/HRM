/**
 * Data residency ENFORCEMENT (step 6.1) — see
 * docs/conventions/privacy-residency.md and
 * docs/conventions/deployment-scaling.md § Regional deployment (the seam
 * this step turns into a real, enforced invariant). `DEPLOYMENT_REGION` is
 * set ONCE, at module-load time, before `AppModule` (and therefore
 * `ConfigModule`) ever compiles — the SAME "separate file per differing
 * top-level config" discipline `licensing-lifetime.e2e-spec.ts`
 * (`LICENSE_MODE=lifetime`) and
 * `resilience-pool-exhaustion-txn-start.e2e-spec.ts`
 * (`DB_POOL_SIZE`/`DB_POOL_TIMEOUT_SECONDS`) already establish, deliberately
 * NOT toggled mid-file: this is what makes the proof independent of exactly
 * when `@nestjs/config`'s `ConfigService` snapshots `process.env`.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.DEPLOYMENT_REGION = 'us-east-1';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const SLUG_LOCAL_REGION = 'residency-e2e-local';
const SLUG_OTHER_REGION = 'residency-e2e-other';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_LOCAL_REGION, SLUG_OTHER_REGION] } } });
}

async function makeTenantWithAdmin(slug: string, hostingRegion: string) {
  const tenant = await prisma.tenant.create({ data: { name: `Residency ${slug}`, slug, defaultCountryCode: 'US', hostingRegion } });
  await seedSystemRolesAndPermissions(prisma, tenant.id);
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, email: `admin@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id } });
  return { tenantId: tenant.id, token: jwt.sign({ sub: admin.id, tenantId: tenant.id }) };
}

describe('data residency enforcement (e2e) — DEPLOYMENT_REGION=us-east-1', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let localRegionTenant: { tenantId: string; token: string };
  let otherRegionTenant: { tenantId: string; token: string };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    localRegionTenant = await makeTenantWithAdmin(SLUG_LOCAL_REGION, 'us-east-1');
    otherRegionTenant = await makeTenantWithAdmin(SLUG_OTHER_REGION, 'me-south-1');
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('a tenant pinned to THIS deployment\'s own region is served normally', async () => {
    await request(app.getHttpServer())
      .get('/privacy/register')
      .set('Host', hostFor(SLUG_LOCAL_REGION))
      .set('Authorization', `Bearer ${localRegionTenant.token}`)
      .expect(200);
  });

  it('a tenant pinned to a DIFFERENT region is rejected (403) before rate limiting or a DB transaction ever opens', async () => {
    const res = await request(app.getHttpServer())
      .get('/privacy/register')
      .set('Host', hostFor(SLUG_OTHER_REGION))
      .set('Authorization', `Bearer ${otherRegionTenant.token}`)
      .expect(403);
    expect(res.body.message).toContain('me-south-1');
    expect(res.body.message).toContain('us-east-1');
  });

});
