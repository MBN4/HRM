/**
 * Phase 6.3 (edge security) — the anti-spoofing half of
 * `configureTrustedProxy`'s proof (see the companion
 * `edge-client-ip-trusted.e2e-spec.ts` for the "correctly resolves a real
 * edge's forwarded IP" half). `TRUSTED_PROXY_HOPS` is left UNSET here —
 * the default for local dev, CI, and any deployment declaring no reverse
 * proxy in front of it at all — so Express's `trust proxy` stays at its
 * own default (`false`) and a caller sending a fake `X-Forwarded-For`
 * header DIRECTLY at this process must NOT be believed: `req.ip` (and
 * therefore `AuditInterceptor`'s captured audit IP) must reflect the
 * real, physically-connecting peer, never a header any caller can set
 * for free. This is the correctness half that actually MATTERS from a
 * security standpoint — see trusted-proxy.ts's own doc comment for why
 * getting this default wrong (trusting a hop that doesn't exist) is a
 * real spoofing vector, not just a cosmetic one.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
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

const TENANT_SLUG = 'edge-ip-untrusted-tenant';
const SPOOFED_CLIENT_IP = '203.0.113.5';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('trusted-proxy client-IP resolution — TRUSTED_PROXY_HOPS unset (default, e2e)', () => {
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
      data: { name: 'Edge IP Untrusted Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
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

  it('IGNORES a spoofed X-Forwarded-For header with no trusted proxy declared — the real connecting peer is captured instead', async () => {
    const host = `${TENANT_SLUG}.${process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local'}`;
    const res = await request(app.getHttpServer())
      .post('/custom-fields/definitions')
      .set('Host', host)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', SPOOFED_CLIENT_IP)
      .send({ entityType: 'Employee', fieldKey: 'edge_ip_untrusted_probe', label: 'Edge IP Probe', fieldType: 'STRING' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId, entityType: 'CustomFieldDefinition', entityId: res.body.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    // The captured IP must NOT be the header a caller controls for free —
    // whatever the real supertest-to-in-process-server peer address is
    // (a loopback address, whose exact string form is environment-
    // dependent), it is never the attacker-supplied value.
    expect((entry!.metadata as { ip?: string })?.ip).not.toBe(SPOOFED_CLIENT_IP);
  });
});
