/**
 * Phase 5.4 — a REAL bug this step's own k6 load test caught (see
 * docs/conventions/observability-load.md § Load testing findings), proven
 * here as its own deterministic regression test, kept in a SEPARATE file
 * from `resilience-pool-exhaustion.e2e-spec.ts` for the SAME reason that
 * file's own header comment gives (env vars set at file scope must not
 * leak into, or race against, another timing-sensitive file).
 *
 * `resilience-pool-exhaustion.e2e-spec.ts` sets `DB_POOL_TIMEOUT_SECONDS=2`
 * — the SAME 2000ms as Prisma's own default `maxWait` for
 * `prisma.$transaction()` (which `withTenantContext` calls with NO
 * explicit `maxWait`/`timeout` options) — so which of the two timeouts
 * actually fires first is unspecified there, and in practice that file
 * observes `P2024` ("Timed out fetching a new connection from the pool").
 * THIS file deliberately sets `DB_POOL_TIMEOUT_SECONDS` MUCH HIGHER (10s)
 * than Prisma's 2000ms `maxWait` default — the SAME relationship this
 * codebase's own DEFAULT dev config actually has (`DB_POOL_TIMEOUT_SECONDS=5`
 * in `.env.example`, still > 2000ms) — which deterministically makes the
 * CLIENT-SIDE `maxWait` timeout fire first, surfacing Prisma's OTHER
 * connection-pressure error, `P2028` ("Transaction API error: Unable to
 * start a transaction in the given time"). Before this step's fix,
 * `DbPoolExhaustionFilter` checked ONLY for `P2024` and let `P2028` fall
 * through to a generic, confusing `500` — meaning the codebase's actual
 * default configuration was NEVER protected by this filter for real pool
 * contention, only the specially-tuned-down config the OTHER e2e file
 * happens to use. This test proves the fix.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.DB_POOL_SIZE = '1';
process.env.DB_POOL_TIMEOUT_SECONDS = '10';
process.env.REQUEST_TIMEOUT_MS = '30000';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'resilience-pool-txn-test-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('connection-pool exhaustion — the transaction-START timeout path (e2e)', () => {
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
      data: { name: 'Resilience Pool Txn Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'user@resilience-pool-txn.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId });

    // Warm the pool — see the sibling file's own identical comment for why.
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

  it('a contender still gets a clean 503 with Retry-After via the P2028 path (maxWait firing before the much-longer pool_timeout), not a raw 500', async () => {
    // DB_POOL_SIZE=1: the holder occupies the only connection for 6s —
    // comfortably longer than Prisma's own 2000ms default `maxWait` for
    // `$transaction()`, but well under this file's 10s `pool_timeout`, so
    // a queued contender's failure is unambiguously the maxWait/P2028
    // path, never P2024. MULTIPLE contenders (not just one) queue for the
    // same single connection, one after another as each ahead of it also
    // fails — real-world concurrent pressure, not a single 1-vs-1 race.
    const holder = slow(6000).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 20 concurrent contenders against the ONE held connection — enough
    // genuine queueing pressure to reliably surface Prisma's client-side
    // `maxWait` (P2028), which a single 1-vs-1 race does not reliably
    // reproduce (verified empirically while writing this test: reproduces
    // with 20 contenders, does not with 1 or 3). This test's scope is
    // narrower than its P2024 sibling's, deliberately: it exists ONLY to
    // prove a contender gets a clean 503 via the P2028 path rather than a
    // raw 500 — the "the holder itself is unaffected" guarantee is
    // already thoroughly proven there and isn't re-asserted here, since
    // 20 simultaneous contenders is a genuinely different (and heavier)
    // load shape than that file's deliberately minimal 1-vs-1 race.
    const contenderPromises = Array.from({ length: 20 }, () => slow(100).then((r) => r));
    const contenders = await Promise.all(contenderPromises);
    const statuses = contenders.map((r) => r.status);
    expect(statuses).toContain(503);
    const rejected = contenders.find((r) => r.status === 503)!;
    expect(rejected.headers['retry-after']).toBeDefined();
    expect(rejected.body.message).toMatch(/temporarily at capacity/i);
    // No 500s anywhere — the actual bug this test guards against: before
    // the fix, EVERY one of these would have been a raw 500, not just
    // absent from a "some succeed, some cleanly 503" mix.
    expect(statuses).not.toContain(500);

    await holder.catch(() => undefined); // let it settle; not this test's own concern (see above)
  }, 20000);
});
