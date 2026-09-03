/**
 * Proves the versioned public API + API-key authentication (step 3.3) end
 * to end over real HTTP — see docs/conventions/integrations.md: a scoped
 * key authenticates a /v1 call via `X-Api-Key` (a SECOND, parallel path
 * alongside JWT — no `Authorization`/`Host`-based tenant resolution
 * involved at all), tenant isolation still holds (RLS), a key cannot
 * exceed its own granted scope, a revoked key is rejected, per-key rate
 * limiting is enforced independently of the per-tenant limiter, and the
 * OpenAPI document for the /v1 surface is actually served.
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { PERMISSIONS } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { setupSwagger } from '../src/swagger';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'int-apikey-tenant-a';
const TENANT_B_SLUG = 'int-apikey-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('integrations — API keys + versioned public API (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let adminTokenA: string;
  let employeeAId: string;
  let employeeBId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupSwagger(app);
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Integrations API-Key Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Integrations API-Key Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    // PROFESSIONAL — API_ACCESS is a PROFESSIONAL+ flag (0.6), reused here
    // rather than a new one.
    await prisma.subscription.create({ data: { tenantId: tenantAId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { tenantId: tenantBId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@int-apikey-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    adminTokenA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'API Key Test Branch A', countryCode: 'US', timezone: 'America/New_York' },
    });
    const employeeA = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        employeeCode: 'APIKEY-A-1',
        firstName: 'Alice',
        lastName: 'ApiKey',
        branchId: branchA.id,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2024-01-01'),
      },
    });
    employeeAId = employeeA.id;

    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, name: 'API Key Test Branch B', countryCode: 'US', timezone: 'America/New_York' },
    });
    const employeeB = await prisma.employee.create({
      data: {
        tenantId: tenantBId,
        employeeCode: 'APIKEY-B-1',
        firstName: 'Bob',
        lastName: 'ApiKey',
        branchId: branchB.id,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2024-01-01'),
      },
    });
    employeeBId = employeeB.id;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function createApiKey(scopes: string[], rateLimitPerMinute?: number) {
    return request(app.getHttpServer())
      .post('/integrations/api-keys')
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ name: `test-key-${scopes.join('+')}`, scopes, rateLimitPerMinute })
      .expect(201);
  }

  function v1Employees(rawKey: string) {
    return request(app.getHttpServer()).get('/v1/employees').set('X-Api-Key', rawKey);
  }

  function v1Employee(rawKey: string, id: string) {
    return request(app.getHttpServer()).get(`/v1/employees/${id}`).set('X-Api-Key', rawKey);
  }

  it('creating a key returns the raw key exactly once; it is never recoverable from a read-back', async () => {
    const created = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    expect(typeof created.body.rawKey).toBe('string');
    expect(created.body.rawKey.startsWith('hrm_')).toBe(true);

    const listed = await request(app.getHttpServer())
      .get('/integrations/api-keys')
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${adminTokenA}`)
      .expect(200);
    const row = listed.body.find((r: { id: string }) => r.id === created.body.id);
    expect(row).toBeDefined();
    // Neither the raw key nor its hash is ever echoed back on a read-back.
    expect(row.rawKey).toBeUndefined();
    expect(row.hashedKey).toBeUndefined();
    expect(row.keyPrefix).toBe(created.body.keyPrefix);
  });

  it('a scoped key authenticates a /v1 call, no Authorization/Host header needed — the key itself resolves the tenant', async () => {
    const created = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    const res = await v1Employees(created.body.rawKey).expect(200);
    expect(res.body.data.some((e: { id: string }) => e.id === employeeAId)).toBe(true);
  });

  it('tenant isolation holds — tenant A key can read tenant A employees, never tenant B, even by direct id', async () => {
    const created = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    await v1Employee(created.body.rawKey, employeeAId).expect(200);
    await v1Employee(created.body.rawKey, employeeBId).expect(404);

    const list = await v1Employees(created.body.rawKey).expect(200);
    expect(list.body.data.some((e: { id: string }) => e.id === employeeBId)).toBe(false);
  });

  it('a key cannot exceed its own granted scope — missing employee.read is a 403, not a 401', async () => {
    const created = await createApiKey([PERMISSIONS.LEAVE_APPROVE]);
    const res = await v1Employees(created.body.rawKey);
    expect(res.status).toBe(403);
  });

  it('leave.approve-scoped key can call /v1/leave/requests; an employee.read-only key cannot', async () => {
    const leaveKey = await createApiKey([PERMISSIONS.LEAVE_APPROVE]);
    await request(app.getHttpServer()).get('/v1/leave/requests').set('X-Api-Key', leaveKey.body.rawKey).expect(200);

    const employeeKey = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    await request(app.getHttpServer()).get('/v1/leave/requests').set('X-Api-Key', employeeKey.body.rawKey).expect(403);
  });

  it('an invalid API key is rejected with 401', async () => {
    await v1Employees('hrm_not-a-real-key-at-all').expect(401);
  });

  it('a revoked key is rejected on its very next call', async () => {
    const created = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    await v1Employees(created.body.rawKey).expect(200);

    await request(app.getHttpServer())
      .delete(`/integrations/api-keys/${created.body.id}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${adminTokenA}`)
      .expect(200);

    await v1Employees(created.body.rawKey).expect(401);
  });

  it('per-key rate limiting is enforced independently of the per-tenant limit', async () => {
    const created = await createApiKey([PERMISSIONS.EMPLOYEE_READ], 3);
    await v1Employees(created.body.rawKey).expect(200);
    await v1Employees(created.body.rawKey).expect(200);
    await v1Employees(created.body.rawKey).expect(200);

    const limited = await v1Employees(created.body.rawKey);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // A DIFFERENT key for the SAME tenant is unaffected — the limit is
    // per-KEY, not per-tenant (the per-tenant limiter's own default quota
    // is far higher and untouched by this test).
    const otherKey = await createApiKey([PERMISSIONS.EMPLOYEE_READ]);
    await v1Employees(otherKey.body.rawKey).expect(200);
  });

  it('the OpenAPI document for the /v1 surface is served and lists the versioned routes', async () => {
    const res = await request(app.getHttpServer()).get('/v1/docs-json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/v1/employees', '/v1/leave/requests']));
    expect(res.body.components.securitySchemes.ApiKeyAuth).toMatchObject({ type: 'apiKey', name: 'X-Api-Key' });
  });

  it('cross-tenant: tenant B cannot mint or use a key that resolves to tenant A, and tenant A cannot see tenant B keys', async () => {
    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@int-apikey-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
    const adminTokenB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    const createdB = await request(app.getHttpServer())
      .post('/integrations/api-keys')
      .set('Host', hostFor(TENANT_B_SLUG))
      .set('Authorization', `Bearer ${adminTokenB}`)
      .send({ name: 'tenant-b-key', scopes: [PERMISSIONS.EMPLOYEE_READ] })
      .expect(201);

    // Tenant B's key resolves to tenant B, never tenant A.
    const res = await v1Employees(createdB.body.rawKey).expect(200);
    expect(res.body.data.some((e: { id: string }) => e.id === employeeAId)).toBe(false);
    expect(res.body.data.some((e: { id: string }) => e.id === employeeBId)).toBe(true);

    const listA = await request(app.getHttpServer())
      .get('/integrations/api-keys')
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${adminTokenA}`)
      .expect(200);
    expect(listA.body.some((row: { id: string }) => row.id === createdB.body.id)).toBe(false);
  });
});
