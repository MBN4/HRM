/**
 * Proves the request-timeout protection (step 0.10) end to end over real
 * HTTP, against a deliberately short `REQUEST_TIMEOUT_MS` — see
 * /CLAUDE.md § Conventions → Graceful degradation + health.
 *
 * `REQUEST_TIMEOUT_MS` is forced BEFORE `AppModule` is ever imported —
 * kept in its OWN file, separate from the connection-pool-exhaustion
 * proof (`resilience-pool-exhaustion.e2e-spec.ts`), specifically so this
 * short timeout can never race ahead of that test's `pool_timeout` and
 * mask what each is independently proving. The pool stays at its normal,
 * generous default size in this file. Jest runs each e2e file in its own
 * worker process, so none of this leaks into other suites.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.REQUEST_TIMEOUT_MS = '600';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'resilience-timeout-test-tenant';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('request timeout (e2e)', () => {
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
      data: { name: 'Resilience Timeout Test Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId, email: 'user@resilience-timeout.test', hashedPassword: 'unused', status: 'ACTIVE' },
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

  it('a handler that runs longer than REQUEST_TIMEOUT_MS gets a clean 408, not an indefinite hang', async () => {
    // REQUEST_TIMEOUT_MS is 600ms for this file; ask the demo endpoint to
    // sleep for 5s via a REAL pg_sleep. This proves the caller gets a
    // fast, clean response per the interceptor's own documented honest
    // limitation (it bounds caller wait time, not underlying work
    // duration — the DB connection this holds is released once the
    // orphaned pg_sleep naturally completes, not at the 600ms mark).
    const startedAt = Date.now();
    const res = await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 5000 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`);
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(408);
    expect(elapsedMs).toBeLessThan(5000);

    // Let the now-orphaned pg_sleep actually finish naturally (rather than
    // being cut off by $disconnect() in afterAll, which would surface as
    // an unhandled rejection from the abandoned query) before teardown.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }, 15000);

  it('an ordinary fast request is completely unaffected', async () => {
    await request(app.getHttpServer())
      .get('/resilience/demo/slow')
      .query({ ms: 10 })
      .set('Host', `${TENANT_SLUG}.${BASE_DOMAIN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
