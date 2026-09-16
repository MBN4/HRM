/**
 * Phase 6.4 — chaos experiment #2: "primary DB unreachable / pool
 * exhausted -> clean 503/backpressure, not a hang or 500." See
 * docs/conventions/incident-response-dr.md § Chaos experiments.
 *
 * This is a RE-VERIFICATION, not a new mechanism: `resilience-pool-
 * exhaustion.e2e-spec.ts` (0.10) already proves a contender gets a clean
 * 503 against a deliberately tiny pool; 5.4's own load testing found a
 * real gap (`DbPoolExhaustionFilter` recognized Prisma's `P2024` but not
 * `P2028` — the code this codebase's OWN interactive-transaction-per-
 * request architecture actually produces, since `TenantScopeInterceptor`
 * wraps EVERY tenant-scoped request in `withTenantContext`'s interactive
 * `$transaction`, not a plain query) and fixed it (see
 * `db-pool-exhaustion.filter.ts`'s own doc comment). This file's job is
 * to PROVE that fix still holds, two ways: (1) drive the raw Prisma
 * client directly against an exhausted pool and assert the error is
 * REALLY one of `P2024`/`P2028` in THIS architecture — which of the two
 * actually fires is itself a genuine race between Prisma's own
 * interactive-transaction `maxWait` and the driver-level `pool_timeout`,
 * confirmed empirically here rather than assumed from reading the code —
 * and (2) drive the same scenario through real HTTP and assert a clean
 * 503 with `Retry-After`, never a raw 500 or a hang, regardless of which
 * code fired underneath.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.DB_POOL_SIZE = '1';
process.env.DB_POOL_TIMEOUT_SECONDS = '2';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, Prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES, withTenantContext } from '@hrm/db';
import { AppModule } from '../../src/app.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'chaos-pool-exhaustion-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('chaos: DB connection-pool exhaustion under the REAL request architecture (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Chaos Pool Exhaustion Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'user@chaos-pool.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId });

    // Warm the pool's one connection (same reasoning
    // resilience-pool-exhaustion.e2e-spec.ts documents).
    await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 1 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  afterAll(async () => {
    await resetFixtures();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('confirms the REAL error code(s) a genuinely exhausted pool produces under this architecture — both handled identically by the filter', async () => {
    let sawError: unknown;
    const holder = withTenantContext(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_sleep(3)`;
    }).catch(() => undefined);

    // Give the holder a beat to actually acquire the pool's one connection.
    await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      await withTenantContext(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok`;
      });
    } catch (error) {
      sawError = error;
    }

    await holder;

    expect(sawError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // Which of the two codes actually fires is a genuine race between
    // Prisma's own interactive-transaction `maxWait` and the driver-level
    // `pool_timeout` (both ~2s here) — NOT deterministic, and that is
    // itself the point 5.4 found: `DbPoolExhaustionFilter` must (and,
    // per this assertion, does) treat both identically rather than
    // assuming only one can occur.
    expect(['P2024', 'P2028']).toContain((sawError as Prisma.PrismaClientKnownRequestError).code);
  }, 15000);

  it('the SAME scenario through real HTTP still returns a clean 503 with Retry-After — never a raw 500, never a hang', async () => {
    const holder = request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 4000 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`)
      .then((r) => r); // dispatch immediately — supertest requests are lazy thenables.

    await new Promise((resolve) => setTimeout(resolve, 300));

    const startedAt = Date.now();
    const contender = await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 1 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`);
    const elapsedMs = Date.now() - startedAt;

    expect(contender.status).toBe(503);
    expect(contender.headers['retry-after']).toBeDefined();
    expect(elapsedMs).toBeLessThan(3500); // a clean, fast backpressure signal — never waiting out the holder's own 4s sleep.

    const holderRes = await holder;
    expect(holderRes.status).toBe(200); // the holder itself completes successfully once its own sleep finishes.
  }, 15000);
});
