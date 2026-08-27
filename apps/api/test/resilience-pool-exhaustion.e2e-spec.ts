/**
 * Proves connection-pool exhaustion protection (step 0.10) end to end
 * over real HTTP, against a DELIBERATELY tiny pool — see /CLAUDE.md §
 * Conventions → Connection-pool protection.
 *
 * `DB_POOL_SIZE`/`DB_POOL_TIMEOUT_SECONDS` are forced BEFORE `@hrm/db`/
 * `AppModule` are ever imported — `packages/db/src/clients.ts` reads these
 * once, at module-load time, to build `appPrisma`'s connection string, so
 * they must be set before that import happens. `REQUEST_TIMEOUT_MS` is
 * deliberately left at its generous default (30s) in THIS file — kept in
 * a SEPARATE file from the request-timeout proof
 * (`resilience-request-timeout.e2e-spec.ts`) specifically so a short
 * request timeout can never race ahead of `pool_timeout` (2s here) and
 * mask what this test is actually proving. Jest runs each e2e file in its
 * own worker process, so none of this leaks into other suites.
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'resilience-pool-test-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('connection-pool exhaustion (e2e)', () => {
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
      data: { name: 'Resilience Pool Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'user@resilience-pool.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId });

    // Warm the pool: appPrisma's sole connection hasn't been physically
    // established yet (fresh client, empty pool) — without this, the
    // race below is flaky, since the holder request's OWN connection
    // handshake can still be in flight when the contender fires, rather
    // than genuinely holding the pool's one slot. One throwaway request
    // forces that handshake to complete before the timing-sensitive test
    // runs.
    await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 1 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function slow(ms: number) {
    return request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('a contender request gets a clean 503 with Retry-After when the pool is exhausted, not a hang', async () => {
    // The pool has exactly ONE connection (DB_POOL_SIZE=1). Hold it for
    // 4s via a real `pg_sleep` — long enough to outlast
    // DB_POOL_TIMEOUT_SECONDS (2s) — while a second concurrent request
    // competes for the same single connection and must time out waiting
    // for one to free up.
    //
    // supertest/superagent `Request` objects are LAZY thenables — merely
    // assigning one to a variable does NOT dispatch it; only calling
    // `.then()`/`.end()` (including via `await`) does. `.then((r) => r)`
    // here forces the holder to actually start immediately, while still
    // leaving it awaitable later — without this, the holder wouldn't be
    // sent until the final `await holder` below, and the "contender"
    // would race against nothing.
    const holder = slow(4000).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const contender = await slow(100);
    expect(contender.status).toBe(503);
    expect(contender.headers['retry-after']).toBeDefined();

    // The holder itself still completes successfully once its sleep ends
    // — exhaustion affects the CONTENDER competing for a connection, not
    // the request already holding one.
    const holderRes = await holder;
    expect(holderRes.status).toBe(200);
  }, 15000);
});
