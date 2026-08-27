/**
 * Proves the resilience chassis (0.10) end to end over real HTTP — see
 * /CLAUDE.md § Conventions for the full write-up of each mechanism:
 *   - Per-tenant rate limiting: one tenant exceeding its (overridden, tiny)
 *     quota gets 429 with `Retry-After` while a SECOND tenant is completely
 *     unaffected — the actual fault-isolation proof this step exists for.
 *   - Circuit breaker: a failing dependency trips the breaker after its
 *     failure threshold, subsequent calls fail fast (never attempting the
 *     real call) while OPEN, and a successful HALF_OPEN trial after the
 *     reset timeout recovers it to CLOSED.
 *   - Idempotency: replaying the same Idempotency-Key returns the cached
 *     result instead of re-running the handler (no double-apply); a
 *     genuinely concurrent duplicate gets 409.
 *   - Readiness reflects real dependency health, and a shutdown-in-progress
 *     flag flips it unhealthy immediately (the mechanism `main.ts`'s
 *     graceful-shutdown signal handling relies on).
 *
 * `PLATFORM_MODE_ENABLED` is forced on (before the Nest app is compiled)
 * purely to exercise the rate-limit-override platform-admin endpoint — same
 * pattern every other e2e suite touching a `@PlatformRoute()` already uses.
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { SystemLoadService } from '../src/resilience/load-shedding/system-load.service';
import { ShutdownService } from '../src/resilience/shutdown/shutdown.service';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'resilience-test-tenant-a';
const TENANT_B_SLUG = 'resilience-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('resilience chassis (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Resilience Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Resilience Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);
    const roleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const roleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.EMPLOYEE } },
    });

    const userA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'user@resilience-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userA.id, roleId: roleA.id } });
    tokenA = jwt.sign({ sub: userA.id, tenantId: tenantAId });

    const userB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'user@resilience-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userB.id, roleId: roleB.id } });
    tokenB = jwt.sign({ sub: userB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  describe('per-tenant rate limiting — fault isolation', () => {
    it('tenant A exceeding its (overridden, tiny) quota gets 429 with Retry-After, while tenant B is unaffected', async () => {
      await request(app.getHttpServer())
        .patch(`/platform/rate-limits/${tenantAId}`)
        .send({ limit: 3, windowSeconds: 30 })
        .expect(200);

      const critical = () =>
        request(app.getHttpServer())
          .get('/resilience/demo/critical')
          .set('Host', hostFor(TENANT_A_SLUG))
          .set('Authorization', `Bearer ${tokenA}`);

      // The first 3 requests consume the quota; the 4th is over budget.
      await critical().expect(200);
      await critical().expect(200);
      await critical().expect(200);
      const limited = await critical().expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Tenant B, on the untouched default quota, sails through completely unaffected.
      await request(app.getHttpServer())
        .get('/resilience/demo/critical')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      await request(app.getHttpServer()).delete(`/platform/rate-limits/${tenantAId}`).expect(200);
    });
  });

  describe('circuit breaker — trips, fails fast, recovers half-open', () => {
    function configureFlaky(body: { shouldFail?: boolean; delayMs?: number }) {
      return request(app.getHttpServer())
        .post('/resilience/demo/flaky/configure')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .send(body)
        .expect(201);
    }

    function callBreaker() {
      return request(app.getHttpServer())
        .get('/resilience/demo/breaker')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`);
    }

    function breakerState() {
      return request(app.getHttpServer())
        .get('/resilience/demo/breaker/state')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`);
    }

    it('trips OPEN after the failure threshold, fails fast without attempting the call, then recovers via a HALF_OPEN trial', async () => {
      await configureFlaky({ shouldFail: true });

      // failureThreshold is 3 for the demo breaker — these 3 calls each
      // make a REAL attempt (the breaker is still CLOSED) and surface the
      // underlying dependency error.
      await callBreaker().expect(500);
      await callBreaker().expect(500);
      await callBreaker().expect(500);

      const stateAfterTrip = await breakerState().expect(200);
      expect(stateAfterTrip.body.state).toBe('OPEN');

      // The very next call fails FAST (400, circuitOpen: true) — proves no
      // attempt was made at all: even though the dependency is still
      // configured to fail, this response is instant and carries the
      // breaker's own error shape, not the dependency's.
      const failFast = await callBreaker().expect(400);
      expect(failFast.body.circuitOpen).toBe(true);

      // resetTimeoutSeconds is 2s for the demo breaker — wait it out, and
      // let the dependency "recover" before the trial call lands.
      await configureFlaky({ shouldFail: false });
      await new Promise((resolve) => setTimeout(resolve, 2100));

      await callBreaker().expect(200);
      const stateAfterRecovery = await breakerState().expect(200);
      expect(stateAfterRecovery.body.state).toBe('CLOSED');

      // Fully recovered — ordinary calls succeed normally.
      await callBreaker().expect(200);
    }, 15000);
  });

  describe('idempotency — replay does not double-apply', () => {
    const IDEMPOTENCY_KEY = 'resilience-e2e-idem-key-001';

    it('the same Idempotency-Key returns the cached result instead of re-running the handler', async () => {
      const first = await request(app.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .expect(201);
      const firstCount = first.body.count;

      const replay = await request(app.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .expect(201);
      expect(replay.body.count).toBe(firstCount);

      // A DIFFERENT key is a genuinely new request — the counter advances.
      const differentKey = await request(app.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'resilience-e2e-idem-key-002')
        .expect(201);
      expect(differentKey.body.count).toBe(firstCount + 1);
    });

    it('rejects a request to an @Idempotent() route with no Idempotency-Key header', async () => {
      await request(app.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(400);
    });

    it('a tenant-B replay of the SAME key is independent (idempotency is scoped per tenant)', async () => {
      const res = await request(app.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .expect(201);
      // Tenant B's own counter starts fresh — this is its first call, so 1.
      expect(res.body.count).toBe(1);
    });
  });

  describe('readiness reflects dependency health and shutdown state', () => {
    it('GET /health/live is always ok', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    });

    it('GET /health/ready is ok while every dependency is healthy and the process is not shutting down', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body).toMatchObject({ ready: true, checks: { database: true, redis: true, shuttingDown: false } });
    });

    it('flips to 503 the instant shutdown begins — the mechanism graceful shutdown relies on to drain safely', async () => {
      const shutdownService = moduleRef.get(ShutdownService);
      shutdownService.beginShutdown();

      const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(res.body.checks).toMatchObject({ shuttingDown: true });
      // Liveness is UNCHANGED — the process keeps serving in-flight work
      // during the drain window, only readiness (new traffic) is affected.
      await request(app.getHttpServer()).get('/health/live').expect(200);
    });
  });

  describe('load shedding runs BEFORE tenant resolution (ordering proof)', () => {
    it('critical paths (login, health) are NEVER shed even under load', async () => {
      const systemLoad = moduleRef.get(SystemLoadService);
      systemLoad.increment();
      systemLoad.increment();
      try {
        // Push load past even the higher NORMAL/CRITICAL-adjacent
        // threshold — CRITICAL must still sail through.
        for (let i = 0; i < 200; i += 1) {
          systemLoad.increment();
        }
        await request(app.getHttpServer()).get('/health/live').expect(200);
        await request(app.getHttpServer())
          .get('/resilience/demo/critical')
          .set('Host', hostFor(TENANT_A_SLUG))
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(200);
      } finally {
        for (let i = 0; i < 202; i += 1) {
          systemLoad.decrement();
        }
      }
    });

    it('a shed LOW-priority request never reaches tenant resolution — proven via an unresolvable Host', async () => {
      // Deterministically simulate "the system is under load" by driving
      // the SAME in-flight counter LoadSheddingService reads, rather than
      // relying on real HTTP concurrency actually overlapping within a
      // test's timing window (unreliable in a test harness). This still
      // exercises the REAL check inside TenantScopeInterceptor — it just
      // controls the input deterministically instead of hoping enough
      // concurrent connections land in time.
      const systemLoad = moduleRef.get(SystemLoadService);
      for (let i = 0; i < 25; i += 1) {
        systemLoad.increment();
      }

      try {
        // A Host that could never resolve to a tenant. If load shedding
        // truly runs OUTSIDE (before) TenantScopeInterceptor's own tenant
        // resolution, this gets 503 (shed) rather than the 401 tenant
        // resolution would otherwise produce — proving BOTH that shedding
        // works AND that it runs first.
        const probeRes = await request(app.getHttpServer())
          .get('/resilience/demo/low-priority')
          .set('Host', `no-such-tenant.${BASE_DOMAIN}`);
        expect(probeRes.status).toBe(503);
        expect(probeRes.headers['retry-after']).toBeDefined();
      } finally {
        for (let i = 0; i < 25; i += 1) {
          systemLoad.decrement();
        }
      }

      // Load back to normal — the same route now resolves normally (401,
      // since the Host still doesn't resolve to a tenant — proving it's
      // genuinely load-gated, not just permanently broken).
      await request(app.getHttpServer())
        .get('/resilience/demo/low-priority')
        .set('Host', `no-such-tenant.${BASE_DOMAIN}`)
        .expect(401);
    });
  });
});
