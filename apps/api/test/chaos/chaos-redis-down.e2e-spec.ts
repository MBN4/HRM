/**
 * Phase 6.4 — chaos experiment #1: "kill/stall a dependency" (Redis).
 * See docs/conventions/incident-response-dr.md § Chaos experiments.
 *
 * Unlike every other e2e file in this suite (which shares the ONE Redis
 * instance `REDIS_URL` already points at), this file spins up its OWN,
 * DISPOSABLE `redis-server` child process on a private port and points
 * `REDIS_URL` at it BEFORE `@hrm/db`/`AppModule` is ever imported (the
 * same "set process.env before the import that reads it" convention
 * `resilience-pool-exhaustion.e2e-spec.ts` already establishes) —
 * precisely so this test can genuinely SIGKILL that dependency without
 * taking down the Redis instance every other suite in this run depends
 * on. This is real infrastructure being killed and restarted, not a
 * mocked client.
 *
 * THE REAL WEAKNESS THIS TEST FOUND AND THE FIX IT PROVES: before this
 * step, `TenantRateLimitService.enforce` — which runs on
 * `TenantScopeInterceptor`'s hot path for EVERY tenant-scoped request,
 * BEFORE the DB transaction even opens — had no try/catch around its
 * Redis calls. An unreachable Redis turned into an uncaught error and a
 * raw, uninformative `500` for every single tenant-scoped request, not a
 * clean degrade — a single dependency blip taking down the whole app,
 * exactly what 0.10's "no layer trusted alone" posture argues against.
 * The fix (see `TenantRateLimitService.enforce`'s own doc comment) makes
 * rate limiting FAIL OPEN when Redis is unreachable: the request is still
 * served (unmetered, but not dropped), a warning is logged, and
 * `hrm_redis_unavailable_fail_open_total` is incremented so the
 * degradation is a real, alertable signal, not a silent gap.
 *
 * Requires local infra up and migrations applied (this file additionally
 * requires a `redis-server` binary on PATH, used only for its own private
 * throwaway instance):
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
const CHAOS_REDIS_PORT = 6397;
process.env.REDIS_URL = `redis://127.0.0.1:${CHAOS_REDIS_PORT}`;

import { ChildProcess, spawn } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../../src/app.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'chaos-redis-down-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

function startChaosRedis(): ChildProcess {
  const child = spawn('redis-server', ['--port', String(CHAOS_REDIS_PORT), '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  return child;
}

async function waitForPort(port: number, { tries = 40, delayMs = 100 } = {}): Promise<boolean> {
  const net = await import('node:net');
  for (let i = 0; i < tries; i += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function waitForPortClosed(port: number, { tries = 40, delayMs = 100 } = {}): Promise<boolean> {
  const net = await import('node:net');
  for (let i = 0; i < tries; i += 1) {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });
    if (closed) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function waitFor<T>(check: () => Promise<T | null>, { tries = 40, delayMs = 250 } = {}): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const result = await check();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('waitFor: condition never became true');
}

describe('chaos: Redis dependency killed and restarted (e2e)', () => {
  let redisProcess: ChildProcess;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    redisProcess = startChaosRedis();
    const up = await waitForPort(CHAOS_REDIS_PORT);
    if (!up) {
      throw new Error('chaos redis-server never came up — is `redis-server` on PATH?');
    }

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Chaos Redis Down Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'chaos-redis-admin@example.com', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId, tokenType: 'access' });
  }, 30000);

  afterAll(async () => {
    await resetFixtures();
    // Best-effort — the app's own REDIS_CLIENT may already be pointed at
    // a chaos redis instance this file is about to kill anyway; ioredis's
    // `.quit()` resolves harmlessly even against an already-broken
    // connection, and this is the SAME explicit-quit convention every
    // other Redis-touching e2e file in this suite already follows (see
    // resilience.e2e-spec.ts), needed here too so this file's own
    // dedicated Redis process doesn't leave a dangling handle behind.
    try {
      await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    } catch {
      // already disconnected — nothing to clean up.
    }
    await app?.close();
    if (redisProcess && !redisProcess.killed) {
      redisProcess.kill('SIGKILL');
    }
  });

  it('baseline: with Redis up, a normal request succeeds and readiness is fully healthy', async () => {
    const health = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(health.body).toEqual({ ready: true, checks: { database: true, redis: true, shuttingDown: false } });

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('killing Redis makes readiness report unhealthy immediately, without crashing the process', async () => {
    redisProcess.kill('SIGKILL');
    const closed = await waitForPortClosed(CHAOS_REDIS_PORT);
    expect(closed).toBe(true);

    const health = await waitFor(async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      return res.body.checks?.redis === false ? res.body : null;
    });
    expect(health).toEqual({ ready: false, checks: { database: true, redis: false, shuttingDown: false } });
  }, 15000);

  it('a real tenant-scoped request DEGRADES GRACEFULLY (served, unmetered) instead of a raw 500 while Redis stays down', async () => {
    // THE FIX under proof: TenantRateLimitService.enforce fails OPEN
    // rather than letting an unreachable Redis surface as an uncaught
    // 500 on every request — see that service's own doc comment and
    // this file's header comment.
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeDefined();
  }, 15000);

  it('recovers cleanly once Redis comes back: readiness heals and rate limiting resumes being enforced', async () => {
    redisProcess = startChaosRedis();
    const up = await waitForPort(CHAOS_REDIS_PORT);
    expect(up).toBe(true);

    const health = await waitFor(async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      return res.body.ready === true ? res.body : null;
    });
    expect(health).toEqual({ ready: true, checks: { database: true, redis: true, shuttingDown: false } });

    // A fresh Redis instance has no counters yet, so rate limiting is
    // provably ACTIVE again (not silently left in the fail-open state) —
    // hammer the tenant's quota until a real 429 comes back.
    let sawRateLimited = false;
    for (let i = 0; i < 250 && !sawRateLimited; i += 1) {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`);
      if (res.status === 429) {
        sawRateLimited = true;
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(sawRateLimited).toBe(true);
  }, 30000);
});
