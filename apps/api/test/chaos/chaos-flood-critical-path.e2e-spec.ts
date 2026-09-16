/**
 * Phase 6.4 — chaos experiment #4: "a request flood -> load shedding
 * protects critical paths." See
 * docs/conventions/incident-response-dr.md § Chaos experiments.
 *
 * `edge-ddos-flood.e2e-spec.ts` (6.3) already proves the core mechanism
 * against the demo routes (`/resilience/demo/low-priority` and
 * `/resilience/demo/critical`) under a genuine concurrent flood, with
 * recovery once it subsides — this file deliberately does NOT redo that
 * proof. It EXTENDS it one step further, onto a REAL production route
 * marked `@Priority('CRITICAL')` for exactly this reason:
 * `POST /auth/login` (see auth.controller.ts) — the actual route this
 * step's own resilience.md doc calls out by name as needing to survive a
 * flood ("`CRITICAL` is NEVER shed at any load ... `POST /auth/login`").
 * A login flood is also the single most realistic real-world DDoS/
 * credential-stuffing shape this system would actually see — proving the
 * DEMO route stays up says nothing on its own about whether the real
 * login endpoint's own auth-service logic (a DB read, an argon2id
 * comparison, its own separate per-email rate limiter) still gets a
 * chance to run under the same concurrent load-shedding pressure that
 * sheds everything else.
 *
 * Distinct, non-existent emails are used per login attempt specifically
 * to stay under `AuthService.login`'s own per-email attempt limiter (5
 * attempts/15min) — this test is about LOAD SHEDDING treating the ROUTE
 * as critical, not about the auth rate limiter, a different layer already
 * proven elsewhere (auth-rbac.e2e-spec.ts).
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../../src/app.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'chaos-flood-critical-tenant';
const LOW_PRIORITY_FLOOD_SIZE = 60;
const LOGIN_FLOOD_SIZE = 15;
const HOLD_OPEN_MS = 200;

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('chaos: a real request flood, proving the REAL /auth/login critical path survives it (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let token: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Chaos Flood Critical Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await seedSystemRolesAndPermissions(prisma, tenant.id);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: 'user@chaos-flood.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId: tenant.id });
  }, 30000);

  afterAll(async () => {
    await resetFixtures();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('under a genuine concurrent flood of low-priority requests, POST /auth/login is never shed (no 503) — only ever a real auth outcome', async () => {
    const floodRequests = Array.from({ length: LOW_PRIORITY_FLOOD_SIZE }, () =>
      request(app.getHttpServer())
        .get('/resilience/demo/low-priority')
        .query({ ms: HOLD_OPEN_MS })
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${token}`),
    );
    // Interleave real login attempts INTO the flood window (not before or
    // after it) — each against a distinct, non-existent email so none of
    // them collide with AuthService's own per-email attempt limiter.
    const loginRequests = Array.from({ length: LOGIN_FLOOD_SIZE }, (_, i) =>
      request(app.getHttpServer())
        .post('/auth/login')
        .set('Host', hostFor(TENANT_SLUG))
        .send({ email: `chaos-flood-${i}@example.com`, password: 'irrelevant-wrong-password' }),
    );

    const [floodResults, loginResults] = await Promise.all([
      Promise.all(floodRequests.map((r) => r.then((res) => res.status).catch(() => -1))),
      Promise.all(loginRequests.map((r) => r.then((res) => res.status).catch(() => -1))),
    ]);

    // The flood itself proves genuine load-shedding pressure existed —
    // otherwise this test would be proving nothing (a login route staying
    // up under NO load is not a load-shedding proof at all).
    const shedCount = floodResults.filter((s) => s === 503).length;
    expect(shedCount).toBeGreaterThan(0);

    // THE PROOF: every login attempt got a REAL auth outcome (401 for
    // bad credentials — these emails don't exist) — never 503. Load
    // shedding's CRITICAL classification protected the route even while
    // it was actively shedding low-priority work all around it.
    for (const status of loginResults) {
      expect(status).not.toBe(503);
      expect([400, 401]).toContain(status);
    }
  }, 30000);

  it('recovers cleanly: once the flood subsides, ordinary low-priority requests succeed again too', async () => {
    const res = await request(app.getHttpServer())
      .get('/resilience/demo/low-priority')
      .set('Host', hostFor(TENANT_SLUG))
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
