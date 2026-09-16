/**
 * Phase 6.3 (edge security) — extends 5.4's load-testing discipline
 * (docs/conventions/observability-load.md § 6-8, the k6
 * `load-shedding.js` scenario) with a genuine, LOCAL, jest `--runInBand`
 * proof of the app-side half of DDoS mitigation: even before any edge
 * WAF/CDN absorbs volumetric traffic (see docs/conventions/edge-security.md
 * → DDoS), the EXISTING 0.10 resilience chassis alone must degrade
 * gracefully under a real flood — critical paths protected, non-critical
 * work shed (not crashed, not hung), and the process recovers the instant
 * the flood subsides.
 *
 * Unlike `resilience.e2e-spec.ts`'s own load-shedding tests (which
 * deterministically DRIVE `SystemLoadService`'s in-flight counter directly
 * — documented there as "unreliable to rely on real HTTP concurrency
 * actually overlapping within a test's timing window"), this file fires a
 * REAL concurrent burst of in-flight HTTP requests (via `Promise.all`
 * against `/resilience/demo/low-priority?ms=<delay>`, which deliberately
 * holds each request open long enough to force genuine overlap — the
 * exact mechanism that route's own doc comment names it for) — a
 * complementary, not a replacement, proof: this one is closer to what a
 * REAL flood looks like, at a scale a jest process can drive reliably
 * without needing k6/Docker.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'edge-ddos-flood-tenant';

// Comfortably under the STARTER-edition default per-tenant quota
// (200 req/60s — see @hrm/shared's DEFAULT_RATE_LIMITS) so this flood
// exercises LOAD SHEDDING specifically, not the per-tenant rate limiter —
// a DIFFERENT layer, already proven under real concurrency by
// observability-load.md § 8's own direct-burst experiment.
const LOW_PRIORITY_FLOOD_SIZE = 60;
const CRITICAL_FLOOD_SIZE = 15;
// Held open long enough (LoadSheddingService admits/releases around the
// WHOLE handler, including this delay) for ~60 concurrent low-priority
// requests to genuinely overlap and push the in-flight counter past the
// default LOAD_SHED_LOW_THRESHOLD (20) before any of them resolve.
const HOLD_OPEN_MS = 200;

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('DDoS-style flood — app-side graceful degradation, before any edge layer (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let token: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Edge DDoS Flood Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await seedSystemRolesAndPermissions(prisma, tenant.id);
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const admin = await prisma.user.create({
      data: { tenantId: tenant.id, email: `admin@${TENANT_SLUG}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id } });
    token = jwt.sign({ sub: admin.id, tenantId: tenant.id });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('sheds non-critical work under a genuine concurrent flood while CRITICAL requests keep succeeding, then recovers cleanly once the flood subsides', async () => {
    const host = hostFor(TENANT_SLUG);

    const lowPriorityFlood = Array.from({ length: LOW_PRIORITY_FLOOD_SIZE }, () =>
      request(app.getHttpServer())
        .get(`/resilience/demo/low-priority?ms=${HOLD_OPEN_MS}`)
        .set('Host', host)
        .set('Authorization', `Bearer ${token}`)
        .then((res) => res.status),
    );
    // Fired in the SAME wall-clock window as the flood above, not before
    // or after it — the whole point of this assertion is that CRITICAL
    // survives WHILE the system is genuinely under load, not merely
    // before/after it.
    const criticalDuringFlood = Array.from({ length: CRITICAL_FLOOD_SIZE }, () =>
      request(app.getHttpServer())
        .get('/resilience/demo/critical')
        .set('Host', host)
        .set('Authorization', `Bearer ${token}`)
        .then((res) => res.status),
    );

    const [lowStatuses, criticalStatuses] = await Promise.all([Promise.all(lowPriorityFlood), Promise.all(criticalDuringFlood)]);

    const shed = lowStatuses.filter((s) => s === 503).length;
    const admitted = lowStatuses.filter((s) => s === 200).length;

    // Graceful degradation, not an all-or-nothing collapse: SOME
    // low-priority requests are shed (proving the mechanism actually
    // engaged under this real concurrency), and SOME still succeed
    // (proving it isn't wrongly blocking everything either) — every
    // status is one of the two expected outcomes, never a crash/hang/500.
    expect(shed).toBeGreaterThan(0);
    expect(admitted).toBeGreaterThan(0);
    expect(shed + admitted).toBe(LOW_PRIORITY_FLOOD_SIZE);

    // CRITICAL is NEVER shed, at any load — every single one succeeds,
    // even fired concurrently with the flood above.
    expect(criticalStatuses.every((s) => s === 200)).toBe(true);

    // Recovery: once the flood has fully drained (every promise above is
    // already settled), an ordinary request succeeds immediately — no
    // stuck/leaked in-flight count, no lingering lockout.
    await request(app.getHttpServer())
      .get('/resilience/demo/low-priority')
      .set('Host', host)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});
