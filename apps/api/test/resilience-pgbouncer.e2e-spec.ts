/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Connection
 * pooling) — proves, over REAL HTTP against the full running app, that
 * routing `appPrisma` through the local PgBouncer instance (docker-compose's
 * `pgbouncer` service, transaction pooling mode) changes NOTHING about this
 * system's existing guarantees:
 *   1. Cross-tenant isolation still holds under heavy, forced connection
 *      reuse (many concurrent, interleaved-tenant requests against a
 *      deliberately tiny pool) — the HTTP-level counterpart to
 *      `packages/db/test/pgbouncer-rls.spec.ts`'s lower-level proof.
 *   2. 0.10's connection-pool-exhaustion backpressure (a clean 503 with
 *      `Retry-After`, never a hang) still works THROUGH the pooler, not
 *      just against Postgres directly.
 *
 * `APP_DATABASE_URL` is forced to the local PgBouncer endpoint, and
 * `DB_POOL_SIZE`/`DB_POOL_TIMEOUT_SECONDS` to a deliberately tiny budget,
 * BEFORE `@hrm/db`/`AppModule` are ever imported — the same "force
 * process.env before the package import" pattern
 * `resilience-pool-exhaustion.e2e-spec.ts` already establishes, for the
 * identical reason (`packages/db/src/clients.ts` reads these once, at
 * module-load time). Kept in its OWN file, never the app's default
 * connection (see docs for why PgBouncer is a configurable, proven-but-
 * opt-in topology rather than every existing test's silent default).
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres pgbouncer redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.APP_DATABASE_URL = 'postgresql://hrm_app:hrm_app_dev_password@localhost:6432/hrm_dev?schema=public&pgbouncer=true';
process.env.DB_POOL_SIZE = '3';
process.env.DB_POOL_TIMEOUT_SECONDS = '2';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'pgbouncer-http-test-tenant-a';
const TENANT_B_SLUG = 'pgbouncer-http-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

describe('PgBouncer, over real HTTP (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantAId: string;
  let tenantBId: string;
  let branchAId: string;
  let branchBId: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'PgBouncer HTTP Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'PgBouncer HTTP Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'QA', hostingRegion: 'me-south-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'PgBouncer HTTP A Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'PgBouncer HTTP B Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });
    branchAId = branchA.id;
    branchBId = branchB.id;

    const roleA = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const roleB = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.EMPLOYEE } } });
    const userA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'user@pgbouncer-http-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    const userB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'user@pgbouncer-http-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userA.id, roleId: roleA.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userB.id, roleId: roleB.id } });
    tokenA = jwt.sign({ sub: userA.id, tenantId: tenantAId });
    tokenB = jwt.sign({ sub: userB.id, tenantId: tenantBId });

    // Warm the pool before the timing-sensitive exhaustion test — same
    // reasoning resilience-pool-exhaustion.e2e-spec.ts documents for itself.
    await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 1 })
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function branches(slug: string, token: string) {
    return request(app.getHttpServer()).get('/tenancy/branches').set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`);
  }

  function slow(ms: number, slug: string, token: string) {
    return request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms })
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`);
  }

  it('no cross-tenant leakage through the pooler under heavy, forced connection reuse (many concurrent, interleaved-tenant requests against a 3-connection pool)', async () => {
    const ROUNDS = 10;
    const calls = Array.from({ length: ROUNDS }, (_, i) => {
      const isA = i % 2 === 0;
      return (isA ? branches(TENANT_A_SLUG, tokenA) : branches(TENANT_B_SLUG, tokenB)).then((res) => ({ isA, res }));
    });

    const results = await Promise.all(calls);
    for (const { isA, res } of results) {
      expect(res.status).toBe(200);
      const ids = (res.body as { id: string }[]).map((b) => b.id);
      expect(ids).toEqual(isA ? [branchAId] : [branchBId]);
    }
  }, 20000);

  it('0.10s connection-pool-exhaustion backpressure still returns a clean 503 with Retry-After through the pooler, not a hang', async () => {
    // The app-side pool is DB_POOL_SIZE=3; PgBouncer's own pool is far
    // larger (see docker-compose.yml), so it's genuinely THIS app
    // instance's own bounded pool — not PgBouncer's — that gets exhausted
    // here, exactly like the direct-connection version of this test.
    const holders = [slow(4000, TENANT_A_SLUG, tokenA), slow(4000, TENANT_A_SLUG, tokenA), slow(4000, TENANT_A_SLUG, tokenA)].map(
      (p) => p.then((r) => r),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const contender = await slow(100, TENANT_A_SLUG, tokenA);
    expect(contender.status).toBe(503);
    expect(contender.headers['retry-after']).toBeDefined();

    const holderResults = await Promise.all(holders);
    for (const res of holderResults) {
      expect(res.status).toBe(200);
    }
  }, 20000);
});
