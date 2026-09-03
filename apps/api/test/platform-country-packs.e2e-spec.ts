/**
 * Proves Country Pack authoring/versioning (step 4.1) end to end over
 * real HTTP — see docs/conventions/vendor-console.md → Country Pack
 * management:
 *   - Create (first version auto-activates), version (drafts, cloned from
 *     the active config by default), edit a DRAFT (an ACTIVE version
 *     cannot be edited in place), activate.
 *   - A malformed config is rejected BOTH at write time (the route's own
 *     ZodValidationPipe) AND again at activation time (the service's own
 *     defensive re-check, proven by writing a malformed row directly and
 *     confirming activation still refuses it).
 *   - Reuses `@hrm/shared`'s EXISTING `countryPackConfigSchema` — no
 *     second validation engine.
 *   - Least-privilege: PLATFORM_SUPPORT cannot author packs.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { cleanupTestPlatformAdmins, createTestPlatformAdmin } from './helpers/platform-test-auth';

const TEST_COUNTRY = 'ZZ';

const validConfig = {
  locale: {
    currencyCode: 'ZZD',
    currencySymbol: 'Z',
    numberFormat: 'en-US',
    dateFormat: 'MM/DD/YYYY',
    defaultLanguage: 'en',
    rtl: false,
    firstDayOfWeek: 'SUNDAY',
  },
  workingTime: {
    standardWeeklyHours: 40,
    weekendDays: ['SATURDAY', 'SUNDAY'],
    overtimeRules: { multiplier: 1.5 },
  },
  leaveDefaults: { annualDays: 20, sickDays: 10, maternityDays: 90, paternityDays: 5 },
  publicHolidays: {},
  tax: { layers: [] },
  statutory: { components: [] },
  requiredEmployeeFields: ['ZZ_ID'],
  payslipTemplate: { language: 'en', lineItems: [{ key: 'gross', label: 'Gross Pay' }] },
  payrollMode: 'CALCULATE',
  hostingRegionHint: 'us-east-1',
};

async function resetFixtures() {
  await prisma.countryPack.deleteMany({ where: { countryCode: TEST_COUNTRY } });
  await cleanupTestPlatformAdmins();
}

describe('platform country-pack authoring/versioning (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let ownerToken: string;
  let supportToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    ownerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    supportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('creates a brand-new country pack, which auto-activates as version 1', async () => {
    const res = await request(app.getHttpServer())
      .post('/platform/country-packs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ countryCode: TEST_COUNTRY, config: validConfig })
      .expect(201);
    expect(res.body).toMatchObject({ countryCode: TEST_COUNTRY, version: 1, isActive: true });
  });

  it('rejects creating the SAME country a second time — use createVersion instead', async () => {
    await request(app.getHttpServer())
      .post('/platform/country-packs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ countryCode: TEST_COUNTRY, config: validConfig })
      .expect(409);
  });

  it('rejects a malformed config at write time (ZodValidationPipe)', async () => {
    await request(app.getHttpServer())
      .post('/platform/country-packs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ countryCode: 'YY', config: { locale: { currencyCode: 'NOTLENGTH3XXX' } } })
      .expect(400);
  });

  it('creates a new DRAFT version, defaulting to a clone of the currently active config', async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/country-packs/${TEST_COUNTRY}/versions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(201);
    expect(res.body).toMatchObject({ countryCode: TEST_COUNTRY, version: 2, isActive: false });
    expect(res.body.config.locale.currencyCode).toBe('ZZD');
  });

  it('can edit the DRAFT version, but not the ACTIVE version 1', async () => {
    const editedConfig = { ...validConfig, leaveDefaults: { ...validConfig.leaveDefaults, annualDays: 25 } };

    await request(app.getHttpServer())
      .put(`/platform/country-packs/${TEST_COUNTRY}/versions/2`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ config: editedConfig })
      .expect(200);

    await request(app.getHttpServer())
      .put(`/platform/country-packs/${TEST_COUNTRY}/versions/1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ config: editedConfig })
      .expect(400);
  });

  it('activates version 2 — version 1 becomes inactive, version 2 becomes active', async () => {
    await request(app.getHttpServer())
      .post(`/platform/country-packs/${TEST_COUNTRY}/versions/2/activate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const versions = await request(app.getHttpServer())
      .get(`/platform/country-packs/${TEST_COUNTRY}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const v1 = versions.body.find((v: { version: number }) => v.version === 1);
    const v2 = versions.body.find((v: { version: number }) => v.version === 2);
    expect(v1.isActive).toBe(false);
    expect(v2.isActive).toBe(true);
    expect(v2.config.leaveDefaults.annualDays).toBe(25);
  });

  it('re-validates at activation time — a malformed row written directly (bypassing the API) is refused', async () => {
    const malformed = await prisma.countryPack.create({
      data: { countryCode: TEST_COUNTRY, version: 3, isActive: false, config: { not: 'a valid pack config' } },
    });
    await request(app.getHttpServer())
      .post(`/platform/country-packs/${TEST_COUNTRY}/versions/${malformed.version}/activate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
  });

  it('GET for an unknown country 404s', async () => {
    await request(app.getHttpServer())
      .get('/platform/country-packs/QQ')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('PLATFORM_SUPPORT cannot author country packs', async () => {
    await request(app.getHttpServer())
      .post(`/platform/country-packs/${TEST_COUNTRY}/versions`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({})
      .expect(403);
  });
});
