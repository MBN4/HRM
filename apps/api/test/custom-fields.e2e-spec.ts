/**
 * Proves the custom-fields framework (0.9) end to end over real HTTP — see
 * /CLAUDE.md § Conventions → Custom fields: defining a typed field,
 * validation (required-field, wrong type, unknown key, ENUM outside
 * `options`), a full round trip via the API, and tenant isolation (RLS).
 *
 * A JWT is minted directly (bypassing the real login flow, exercised in
 * full by auth-rbac.e2e-spec.ts) — same rationale every other e2e suite in
 * this codebase already documents for doing the same thing.
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
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'cf-test-tenant-a';
const TENANT_B_SLUG = 'cf-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

describe('custom fields (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let tokenAdminA: string;
  let tokenEmployeeA: string;
  let tokenAdminB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Custom Fields Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Custom Fields Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const adminRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminRoleB = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@cf-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminRoleA.id } });
    tokenAdminA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });

    const employeeA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'employee@cf-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeRoleA.id } });
    tokenEmployeeA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@cf-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminRoleB.id } });
    tokenAdminB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function defineField(token: string, body: unknown, host = TENANT_A_SLUG) {
    return request(app.getHttpServer())
      .post('/custom-fields/definitions')
      .set('Host', hostFor(host))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  describe('defining a field', () => {
    it('rejects a caller without custom_field.manage', async () => {
      await defineField(tokenEmployeeA, {
        entityType: 'Employee',
        fieldKey: 'shirt_size',
        label: 'Shirt size',
        fieldType: 'ENUM',
        options: ['S', 'M', 'L'],
      }).expect(403);
    });

    it('rejects ENUM without options', async () => {
      await defineField(tokenAdminA, {
        entityType: 'Employee',
        fieldKey: 'shirt_size',
        label: 'Shirt size',
        fieldType: 'ENUM',
      }).expect(400);
    });

    it('a TENANT_ADMIN can define a STRING, a NUMBER, and an ENUM field on "Employee"', async () => {
      await defineField(tokenAdminA, {
        entityType: 'Employee',
        fieldKey: 'shirt_size',
        label: 'Shirt size',
        fieldType: 'ENUM',
        options: ['S', 'M', 'L', 'XL'],
        isRequired: true,
      }).expect(201);

      await defineField(tokenAdminA, {
        entityType: 'Employee',
        fieldKey: 'emergency_contact',
        label: 'Emergency contact',
        fieldType: 'STRING',
      }).expect(201);

      await defineField(tokenAdminA, {
        entityType: 'Employee',
        fieldKey: 'years_experience',
        label: 'Years of experience',
        fieldType: 'NUMBER',
      }).expect(201);

      const res = await request(app.getHttpServer())
        .get('/custom-fields/definitions/Employee')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenEmployeeA}`)
        .expect(200);
      expect(res.body.map((d: { fieldKey: string }) => d.fieldKey).sort()).toEqual([
        'emergency_contact',
        'shirt_size',
        'years_experience',
      ]);
    });
  });

  describe('setting values — validated, then round-trips via the API', () => {
    const entityId = 'emp-001';

    it('rejects a missing required field', async () => {
      await request(app.getHttpServer())
        .put(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ emergency_contact: 'Jane Doe' })
        .expect(400);
    });

    it('rejects an ENUM value outside `options`', async () => {
      await request(app.getHttpServer())
        .put(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ shirt_size: 'XXL', emergency_contact: 'Jane Doe' })
        .expect(400);
    });

    it('rejects an unknown field key', async () => {
      await request(app.getHttpServer())
        .put(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ shirt_size: 'M', not_a_real_field: 'x' })
        .expect(400);
    });

    it('rejects a NUMBER field given a string', async () => {
      await request(app.getHttpServer())
        .put(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ shirt_size: 'M', years_experience: 'five' })
        .expect(400);
    });

    it('accepts a valid set and round-trips it back via GET', async () => {
      await request(app.getHttpServer())
        .put(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ shirt_size: 'M', emergency_contact: 'Jane Doe', years_experience: 5 })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${tokenEmployeeA}`)
        .expect(200);

      expect(res.body.values).toEqual({ shirt_size: 'M', emergency_contact: 'Jane Doe', years_experience: 5 });
    });

    it('tenant B sees no field definitions and no values for tenant A\'s entity (RLS)', async () => {
      const defsRes = await request(app.getHttpServer())
        .get('/custom-fields/definitions/Employee')
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenAdminB}`)
        .expect(200);
      expect(defsRes.body).toEqual([]);

      const valuesRes = await request(app.getHttpServer())
        .get(`/custom-fields/values/Employee/${entityId}`)
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tokenAdminB}`)
        .expect(200);
      expect(valuesRes.body.values).toEqual({});
    });
  });
});
