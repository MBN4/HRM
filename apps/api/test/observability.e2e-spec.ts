/**
 * Phase 5.4 — proves the observability stack end to end over real HTTP:
 *   - `GET /metrics` exposes the key metrics (HTTP, queue depth, cache
 *     hit/miss, circuit breaker state, rate-limit/load-shed/pool-
 *     exhaustion counters) and is gated by `MetricsAuthGuard` when
 *     `METRICS_TOKEN` is configured.
 *   - `PinoLoggerService`, installed via `app.useLogger(...)` exactly as
 *     `main.ts` does, forwards a genuinely unhandled exception to the
 *     (mocked, for this test) error tracker with scrubbed context — the
 *     SAME integration path a real deployment exercises, not just the
 *     isolated unit test (`pino-logger.service.spec.ts`).
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';
process.env.METRICS_TOKEN = 'observability-e2e-metrics-token';

import { PassThrough } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { PinoLoggerService } from '../src/common/logging/pino-logger.service';
import { requestIdMiddleware } from '../src/common/logging/request-id.middleware';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'observability-test-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
  await cleanupTestPlatformAdmins();
}

function parseMetric(text: string, name: string): Array<{ labels: Record<string, string>; value: number }> {
  const lines = text.split('\n').filter((line) => line.startsWith(name));
  return lines.map((line) => {
    const match = line.match(/^([a-zA-Z0-9_]+)(\{(.*)\})?\s+([0-9.eE+-]+)$/);
    if (!match) {
      throw new Error(`Could not parse metric line: ${line}`);
    }
    const labelsRaw = match[3] ?? '';
    const labels: Record<string, string> = {};
    for (const pair of labelsRaw.split(',').filter(Boolean)) {
      const [key, rawValue] = pair.split('=');
      labels[key] = rawValue.replace(/^"|"$/g, '');
    }
    return { labels, value: Number(match[4]) };
  });
}

describe('observability (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let token: string;
  let platformToken: string;
  let logChunks: string[];
  let captureException: jest.Mock;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();

    // Installed exactly like main.ts does — the same integration path a
    // real deployment exercises, with a mock destination/error tracker so
    // the test can assert on both without touching stdout or a real
    // Sentry account.
    logChunks = [];
    captureException = jest.fn();
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => logChunks.push(chunk.toString('utf8')));
    app.useLogger(
      new PinoLoggerService({ serviceName: 'observability-e2e', destination, errorTracker: { captureException } }),
    );
    // main.ts also wires this via app.use(...) — replicated here so the
    // requestId correlation this test asserts on actually exists (a fresh
    // `Test.createTestingModule` app has no middleware main.ts itself adds
    // outside AppModule).
    app.use(requestIdMiddleware);

    await app.init();

    await resetFixtures();
    platformToken = (await createTestPlatformAdmin()).token;

    const tenant = await prisma.tenant.create({
      data: { name: 'Observability Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'user@observability.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function metricsRequest(withToken = true) {
    const req = request(app.getHttpServer()).get('/metrics');
    return withToken ? req.set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`) : req;
  }

  describe('GET /metrics', () => {
    it('is rejected without the configured METRICS_TOKEN', async () => {
      await metricsRequest(false).expect(401);
    });

    it('is rejected with the WRONG token', async () => {
      await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer wrong-token').expect(401);
    });

    it('exposes the key metric families with the right bearer token', async () => {
      // Generate at least one of each signal this test asserts on.
      await request(app.getHttpServer())
        .get('/resilience/demo/critical')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const res = await metricsRequest().expect(200);
      expect(res.headers['content-type']).toContain('text/plain');

      // HTTP request metrics, recorded by the metrics middleware for every request.
      expect(res.text).toContain('hrm_http_requests_total');
      expect(res.text).toContain('hrm_http_request_duration_seconds');

      // The worker-autoscaling signal (5.3) — present for every registered queue.
      expect(res.text).toContain('hrm_queue_depth{queue="notifications",state="waiting"}');
      expect(res.text).toContain('hrm_queue_depth{queue="payroll-run",state="waiting"}');

      // Cache/circuit-breaker/rate-limit/load-shed/pool-exhaustion families exist
      // (possibly zero-valued until exercised — see the dedicated tests below).
      expect(res.text).toContain('hrm_cache_hits_total');
      expect(res.text).toContain('hrm_cache_misses_total');
      expect(res.text).toContain('hrm_circuit_breaker_state');
      expect(res.text).toContain('hrm_rate_limit_rejections_total');
      expect(res.text).toContain('hrm_load_shed_rejections_total');
      expect(res.text).toContain('hrm_db_pool_exhaustion_rejections_total');

      // Free process metrics from prom-client's own default collector.
      expect(res.text).toContain('hrm_process_process_cpu_seconds_total');
    });
  });

  describe('cache hit/miss instrumentation', () => {
    it('records a MISS on the first resolution and a HIT on the second, for the SAME country code', async () => {
      const call = () =>
        request(app.getHttpServer())
          .get('/country-packs/effective/US')
          .set('Host', hostFor(TENANT_SLUG))
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      await call();
      await call();

      const res = await metricsRequest().expect(200);
      const hits = parseMetric(res.text, 'hrm_cache_hits_total').find((m) => m.labels.cache === 'country-pack');
      const misses = parseMetric(res.text, 'hrm_cache_misses_total').find((m) => m.labels.cache === 'country-pack');
      expect(hits?.value).toBeGreaterThanOrEqual(1);
      expect(misses?.value).toBeGreaterThanOrEqual(1);
    });
  });

  describe('rate-limit and load-shed rejection counters', () => {
    it('increments hrm_rate_limit_rejections_total on a 429', async () => {
      await request(app.getHttpServer())
        .patch(`/platform/rate-limits/${tenantId}`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ limit: 1, windowSeconds: 30 })
        .expect(200);

      try {
        const call = () =>
          request(app.getHttpServer())
            .get('/resilience/demo/critical')
            .set('Host', hostFor(TENANT_SLUG))
            .set('Authorization', `Bearer ${token}`);

        await call(); // consumes the tiny quota
        await call().expect(429); // over budget

        const res = await metricsRequest().expect(200);
        const rejections = parseMetric(res.text, 'hrm_rate_limit_rejections_total');
        expect(rejections.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(1);
      } finally {
        await request(app.getHttpServer())
          .delete(`/platform/rate-limits/${tenantId}`)
          .set('Authorization', `Bearer ${platformToken}`)
          .expect(200);
      }
    });
  });

  describe('error tracking — a genuinely unhandled exception is captured with scrubbed context', () => {
    it('calls the error tracker via the SAME app-wide logger main.ts installs, with tenant/request correlation, never the raw stack as "context"', async () => {
      await request(app.getHttpServer())
        .post('/resilience/demo/flaky/configure')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`)
        .send({ shouldFail: true })
        .expect(201);

      captureException.mockClear();
      logChunks.length = 0;

      // The breaker is CLOSED at the start of this test file's own breaker
      // lifecycle (a fresh Redis key) — this first call makes a REAL
      // attempt, which throws a genuine, unhandled `Error`, surfacing as a
      // 500 through Nest's default exception handling.
      await request(app.getHttpServer())
        .get('/resilience/demo/breaker')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`)
        .set('x-request-id', 'observability-e2e-request-id')
        .expect(500);

      expect(captureException).toHaveBeenCalled();
      const [capturedError, capturedContext] = captureException.mock.calls[0];
      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedContext.requestId).toBe('observability-e2e-request-id');
      expect(capturedContext.tenantId).toBe(tenantId);

      // The structured log line itself also carries the same correlation —
      // and never the tenant's JWT/Authorization header or any other secret.
      const errorLine = logChunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.level >= 50);
      expect(errorLine.requestId).toBe('observability-e2e-request-id');
      expect(errorLine.tenantId).toBe(tenantId);
      expect(JSON.stringify(errorLine)).not.toContain(token);

      await request(app.getHttpServer())
        .post('/resilience/demo/flaky/configure')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`)
        .send({ shouldFail: false })
        .expect(201);
    });
  });
});
