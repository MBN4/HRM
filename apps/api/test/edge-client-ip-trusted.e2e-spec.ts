/**
 * Phase 6.3 (edge security) — proves `configureTrustedProxy` end to end
 * over real HTTP: when THIS deployment declares it sits behind exactly
 * one trusted reverse-proxy hop (`TRUSTED_PROXY_HOPS=1` — the k8s ingress
 * alone, see deploy/k8s/base/configmap.yaml), `req.ip` resolves the
 * FORWARDED client address from `X-Forwarded-For`, not the proxy's own
 * socket address — which is what makes `AuditInterceptor`'s captured
 * `ip` field (see audit.interceptor.ts) actually mean "the real client",
 * not "whichever hop connected to this process most recently".
 *
 * The companion file, `edge-client-ip-untrusted.e2e-spec.ts`, proves the
 * OPPOSITE and equally important half: with no trusted hop declared (the
 * default), the identical spoofed header is ignored. Split into two
 * files — the SAME "separate file per differing top-level env config"
 * discipline `privacy-residency.e2e-spec.ts`/`licensing-lifetime.e2e-spec.ts`/
 * `resilience-pool-exhaustion-txn-start.e2e-spec.ts` already establish —
 * `TRUSTED_PROXY_HOPS` is read once by `configureTrustedProxy` at
 * bootstrap (baked into the Express app's own `trust proxy` setting, not
 * re-read per request), so toggling it mid-file would only prove
 * something about re-compiling a SECOND app instance, not about this
 * env var's own bootstrap-time semantics — cleaner to keep genuinely
 * separate.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.TRUSTED_PROXY_HOPS = '1';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { configureSecurity } from '../src/security/configure-security';
import { configureTrustedProxy } from '../src/security/trusted-proxy';

const TENANT_SLUG = 'edge-ip-trusted-tenant';
const SPOOFED_CLIENT_IP = '203.0.113.5';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('trusted-proxy client-IP resolution — TRUSTED_PROXY_HOPS=1 (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let adminToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustedProxy(app, app.get(ConfigService));
    configureSecurity(app);
    await app.init();

    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Edge IP Trusted Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const admin = await prisma.user.create({
      data: { tenantId, email: `admin@${TENANT_SLUG}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: admin.id, roleId: adminRole.id } });
    adminToken = jwt.sign({ sub: admin.id, tenantId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('resolves the FORWARDED client IP (not the test harness\'s own loopback peer) into the audit trail', async () => {
    const host = `${TENANT_SLUG}.${process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local'}`;
    const res = await request(app.getHttpServer())
      .post('/custom-fields/definitions')
      .set('Host', host)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', SPOOFED_CLIENT_IP)
      .send({ entityType: 'Employee', fieldKey: 'edge_ip_trusted_probe', label: 'Edge IP Probe', fieldType: 'STRING' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId, entityType: 'CustomFieldDefinition', entityId: res.body.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect((entry!.metadata as { ip?: string })?.ip).toBe(SPOOFED_CLIENT_IP);
  });
});
