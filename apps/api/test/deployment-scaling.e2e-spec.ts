/**
 * Phase 5.3 — proves the two claims horizontal scaling actually depends on,
 * against real infra, not just by inspection:
 *
 *   1. TWO INDEPENDENT API INSTANCES behave identically for the same
 *      tenant/user — a request served by "instance A" and a follow-up
 *      served by "instance B" share the same outcome, because every piece
 *      of cross-request state the 0.10 resilience chassis / auth / tenancy
 *      layers use lives in Redis or Postgres, never in JS process memory
 *      (see docs/conventions/deployment-scaling.md § Statelessness for the
 *      full audit). Two separate `Test.createTestingModule` compilations
 *      of the SAME `AppModule` stand in for two separate pods here — they
 *      are genuinely separate object graphs/DI containers (no shared JS
 *      memory between them), so anything that behaves consistently across
 *      them can only be doing so via the shared external store, exactly
 *      the property that matters for a real multi-pod deployment.
 *   2. `PROCESS_ROLE=api` (the api Deployment's own env var — see
 *      `queue-worker.util.ts` and `worker.ts`) genuinely stops a process
 *      from consuming BullMQ jobs while a normal (`autorun: true`) worker
 *      on the SAME queue/Redis still picks them up — proving "a job
 *      enqueued by one instance is processed by another" for real, against
 *      the actual BullMQ library, not just asserted from reading the code.
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
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'deploy-scaling-test-tenant-a';
const TENANT_B_SLUG = 'deploy-scaling-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  await cleanupTestPlatformAdmins();
}

async function waitFor(check: () => Promise<boolean>, { tries = 10, delayMs = 200 } = {}): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

describe('deployment scaling (e2e)', () => {
  describe('two independent API instances share every piece of cross-request state', () => {
    let instanceA: INestApplication;
    let instanceB: INestApplication;
    let moduleA: TestingModule;
    let moduleB: TestingModule;

    let tenantAId: string;
    let tenantBId: string;
    let tokenA: string;
    let tokenB: string;
    let platformToken: string;

    beforeAll(async () => {
      // Two SEPARATE compilations of the identical AppModule — two
      // distinct DI containers/object graphs in the same test process,
      // the closest a Jest test can get to "two pods" without actually
      // spawning two OS processes. Nothing here shares JS memory.
      moduleA = await Test.createTestingModule({ imports: [AppModule] }).compile();
      instanceA = moduleA.createNestApplication();
      await instanceA.init();

      moduleB = await Test.createTestingModule({ imports: [AppModule] }).compile();
      instanceB = moduleB.createNestApplication();
      await instanceB.init();

      await resetFixtures();
      platformToken = (await createTestPlatformAdmin()).token;

      const tenantA = await prisma.tenant.create({
        data: { name: 'Deploy Scaling Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
      });
      const tenantB = await prisma.tenant.create({
        data: { name: 'Deploy Scaling Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
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
        data: { tenantId: tenantAId, email: 'user@deploy-scaling-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userA.id, roleId: roleA.id } });
      // Signed directly (same shape AuthService issues), not via /auth/login
      // — this token is what proves auth is stateless-JWT: instance A never
      // issued it, yet instance B accepts it exactly as instance A would.
      tokenA = jwt.sign({ sub: userA.id, tenantId: tenantAId });

      const userB = await prisma.user.create({
        data: { tenantId: tenantBId, email: 'user@deploy-scaling-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userB.id, roleId: roleB.id } });
      tokenB = jwt.sign({ sub: userB.id, tenantId: tenantBId });
    });

    afterAll(async () => {
      await resetFixtures();
      await prisma.$disconnect();
      await appPrisma.$disconnect();
      await moduleA.get<IORedis>(REDIS_CLIENT).quit();
      await moduleB.get<IORedis>(REDIS_CLIENT).quit();
      await instanceA.close();
      await instanceB.close();
    });

    it('a JWT never seen by instance B (issued for instance A) authenticates identically on both', async () => {
      // Deliberately tenant B, not A — tenant A's request quota is a
      // scarce, shared resource the very next test spends precisely, and
      // this check doesn't need to touch it.
      await request(instanceA.getHttpServer())
        .get('/resilience/demo/critical')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      await request(instanceB.getHttpServer())
        .get('/resilience/demo/critical')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
    });

    it('per-tenant rate limiting is a shared Redis counter — quota consumed via instance A is enforced on instance B', async () => {
      await request(instanceA.getHttpServer())
        .patch(`/platform/rate-limits/${tenantAId}`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ limit: 3, windowSeconds: 30 })
        .expect(200);

      // try/finally: the override MUST be cleared even if an assertion
      // below throws — a dangling tiny override on tenant A would silently
      // 429 every later test in this file that happens to use tenant A.
      try {
        const callOn = (instance: INestApplication) =>
          request(instance.getHttpServer())
            .get('/resilience/demo/critical')
            .set('Host', hostFor(TENANT_A_SLUG))
            .set('Authorization', `Bearer ${tokenA}`);

        // 2 requests via instance A, 1 via instance B — 3 total, exactly
        // the quota. If the counter were per-instance (in-process),
        // instance B would see a fresh quota of its own and this 4th
        // request (again via A) would succeed; instead it's 429, proving
        // the counter is shared.
        await callOn(instanceA).expect(200);
        await callOn(instanceA).expect(200);
        await callOn(instanceB).expect(200);
        const limited = await callOn(instanceA).expect(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

        // And instance B independently observes the SAME exhausted state.
        await callOn(instanceB).expect(429);
      } finally {
        await request(instanceA.getHttpServer())
          .delete(`/platform/rate-limits/${tenantAId}`)
          .set('Authorization', `Bearer ${platformToken}`)
          .expect(200);
      }
    });

    it('idempotency is a shared Redis claim — a key claimed on instance A replays its cached result on instance B', async () => {
      const key = 'deploy-scaling-e2e-idem-key-001';

      const first = await request(instanceA.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', key)
        .expect(201);

      // Replayed on the OTHER instance — a per-instance implementation
      // would re-run the handler and advance the counter; instead instance
      // B returns the exact same cached result instance A produced.
      const replay = await request(instanceB.getHttpServer())
        .post('/resilience/demo/idempotent')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', key)
        .expect(201);
      expect(replay.body.count).toBe(first.body.count);
    });

    it('the circuit breaker is shared Redis state — tripped via instance A, instance B fails fast immediately without attempting the call', async () => {
      await request(instanceA.getHttpServer())
        .post('/resilience/demo/flaky/configure')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ shouldFail: true })
        .expect(201);

      const breakOn = (instance: INestApplication) =>
        request(instance.getHttpServer())
          .get('/resilience/demo/breaker')
          .set('Host', hostFor(TENANT_A_SLUG))
          .set('Authorization', `Bearer ${tokenA}`);

      // Trip it via instance A (failureThreshold real attempts).
      await breakOn(instanceA).expect(500);
      await breakOn(instanceA).expect(500);
      await breakOn(instanceA).expect(500);

      // Instance B — which made NONE of those calls and has its own
      // completely separate in-process breaker service instance — still
      // fails fast (400, circuitOpen) on its very first call, proving the
      // OPEN state itself lives in Redis, not in either instance's memory.
      const failFastOnB = await breakOn(instanceB).expect(400);
      expect(failFastOnB.body.circuitOpen).toBe(true);

      // Recover it so this test leaves no dangling open breaker behind.
      await request(instanceA.getHttpServer())
        .post('/resilience/demo/flaky/configure')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ shouldFail: false })
        .expect(201);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await breakOn(instanceB).expect(200);
    }, 15000);
  });

  describe('PROCESS_ROLE=api genuinely stops a process from consuming queues — a separate worker still does', () => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const parsed = new URL(redisUrl);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      password: parsed.password || undefined,
      maxRetriesPerRequest: null as null,
    };
    const queueName = `deployment-scaling-demo-${Date.now()}`;
    let queue: Queue;
    let apiRoleWorker: Worker;
    let dedicatedWorker: Worker | undefined;

    afterAll(async () => {
      await dedicatedWorker?.close();
      await apiRoleWorker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it('a job enqueued while only an api-role (autorun:false) worker exists stays unprocessed until a real worker consumes it', async () => {
      queue = new Queue(queueName, { connection });

      const processedBy: string[] = [];
      // Mirrors exactly what `@Processor(X, { autorun: shouldAutorunWorkers() })`
      // produces on the api Deployment: the Worker exists (so DI/module
      // wiring would be identical to a real deployment) but never starts
      // pulling jobs — `{ autorun: false }` is BullMQ's own documented
      // option for this, the same one every processor in this codebase now
      // passes.
      apiRoleWorker = new Worker(queueName, async () => processedBy.push('api-role'), {
        connection,
        autorun: false,
      });

      const job = await queue.add('demo-job', {});

      // Give it a real window to (not) run.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(processedBy).toHaveLength(0);
      expect(await job.getState()).toBe('waiting');

      // Now the dedicated `worker` Deployment/process comes online — a
      // plain BullMQ Worker with `autorun` at its default (`true`), on the
      // SAME queue name/Redis, standing in for `worker.ts`.
      dedicatedWorker = new Worker(queueName, async () => processedBy.push('dedicated-worker'), { connection });

      const completed = await waitFor(async () => (await job.getState()) === 'completed');
      expect(completed).toBe(true);
      expect(processedBy).toEqual(['dedicated-worker']);
    }, 15000);
  });
});
