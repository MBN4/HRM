/**
 * Proves the step 3.3 adapter seams end to end: the accounting export
 * (QuickBooks/Xero-shaped) seam is invokable via its `NoopAccountingAdapter`
 * stub against real payroll-run/expense-claim rows; the biometric device
 * seam is formalized with a real device registry + secret-authenticated
 * ingestion endpoint that calls the SAME `BIOMETRIC_DEVICE_ADAPTER`
 * (`ManualBiometricDeviceAdapter`) 1.3 already established, producing a
 * real `AttendanceRecord`; and Slack routes a REAL notification through the
 * exact same channel/provider/circuit-breaker pipeline EMAIL/SMS/PUSH
 * already use, ending in a real HTTP POST to a local receiver.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { AppModule } from '../src/app.module';
import { EncryptionService } from '../src/common/encryption/encryption.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_SLUG = 'int-adapters-tenant-a';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 10000, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('integrations — adapter seams (accounting/biometric/Slack) (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantId: string;
  let adminToken: string;
  let adminUserId: string;
  let branchId: string;
  let employeeId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenant = await prisma.tenant.create({
      data: { name: 'Integrations Adapters Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    await prisma.subscription.create({ data: { tenantId, edition: 'ENTERPRISE', status: 'ACTIVE' } });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const admin = await prisma.user.create({
      data: { tenantId, email: 'admin@int-adapters-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId, userId: admin.id, roleId: adminRole.id } });
    adminToken = jwt.sign({ sub: admin.id, tenantId });
    adminUserId = admin.id;

    const branch = await prisma.branch.create({
      data: { tenantId, name: 'Adapters Test Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchId = branch.id;

    const employee = await prisma.employee.create({
      data: {
        tenantId,
        employeeCode: 'ADAPTERS-EMP-1',
        firstName: 'Dana',
        lastName: 'Device',
        branchId,
        employmentType: 'FULL_TIME',
        joinDate: new Date('2024-01-01'),
      },
    });
    employeeId = employee.id;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  // --- Accounting -----------------------------------------------------

  describe('accounting export seam', () => {
    it('exports a real payroll run via the NoopAccountingAdapter stub', async () => {
      const run = await prisma.payrollRun.create({
        data: {
          tenantId,
          branchId,
          periodYear: 2026,
          periodMonth: 1,
          payrollMode: 'CALCULATE',
          currencyCode: 'USD',
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/integrations/accounting/export/payroll-runs/${run.id}`)
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(res.body.externalReference.startsWith('noop-')).toBe(true);
      expect(typeof res.body.exportedAt).toBe('string');
    });

    it('exports a real expense claim via the same stub', async () => {
      const claim = await prisma.expenseClaim.create({
        data: { tenantId, employeeId, branchId, status: 'DRAFT', currencyCode: 'USD', totalAmount: 0 },
      });

      const res = await request(app.getHttpServer())
        .post(`/integrations/accounting/export/expense-claims/${claim.id}`)
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(res.body.externalReference.startsWith('noop-')).toBe(true);
    });

    it('a non-existent id 404s rather than silently exporting nothing', async () => {
      await request(app.getHttpServer())
        .post('/integrations/accounting/export/payroll-runs/00000000-0000-0000-0000-000000000000')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // --- Biometric device seam -------------------------------------------

  describe('biometric device seam', () => {
    it('formalizes the 1.3 seam: a registered device pushes a real punch through the UNCHANGED BIOMETRIC_DEVICE_ADAPTER', async () => {
      const registered = await request(app.getHttpServer())
        .post('/integrations/biometric/devices')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ deviceId: 'device-001', name: 'Lobby Scanner' })
        .expect(201);
      const secret: string = registered.body.secret;
      expect(typeof secret).toBe('string');

      const punch = await request(app.getHttpServer())
        .post('/integrations/biometric/devices/device-001/punches')
        .set('X-Tenant-Id', tenantId)
        .set('X-Device-Secret', secret)
        .send({ employeeCode: 'ADAPTERS-EMP-1', direction: 'IN' })
        .expect(201);
      expect(punch.body.employeeId).toBe(employeeId);

      const record = await prisma.attendanceRecord.findFirst({ where: { tenantId, employeeId, clockInSource: 'BIOMETRIC' } });
      expect(record).not.toBeNull();
    });

    it('an unknown device is rejected', async () => {
      await request(app.getHttpServer())
        .post('/integrations/biometric/devices/no-such-device/punches')
        .set('X-Tenant-Id', tenantId)
        .set('X-Device-Secret', 'whatever')
        .send({ employeeCode: 'ADAPTERS-EMP-1', direction: 'IN' })
        .expect(401);
    });

    it('the wrong secret for a real device is rejected', async () => {
      await request(app.getHttpServer())
        .post('/integrations/biometric/devices/device-001/punches')
        .set('X-Tenant-Id', tenantId)
        .set('X-Device-Secret', 'definitely-wrong')
        .send({ employeeCode: 'ADAPTERS-EMP-1', direction: 'OUT' })
        .expect(401);
    });

    it('a disabled device is rejected even with the correct secret', async () => {
      const registered = await request(app.getHttpServer())
        .post('/integrations/biometric/devices')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ deviceId: 'device-002', name: 'Side Door Scanner' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/integrations/biometric/devices/device-002/disable')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      await request(app.getHttpServer())
        .post('/integrations/biometric/devices/device-002/punches')
        .set('X-Tenant-Id', tenantId)
        .set('X-Device-Secret', registered.body.secret)
        .send({ employeeCode: 'ADAPTERS-EMP-1', direction: 'IN' })
        .expect(401);
    });
  });

  // --- Slack — a REAL notification channel, reusing the 0.8 provider seam --

  describe('Slack notification channel', () => {
    let receiver: Server;
    let received: Array<{ text: string }>;

    beforeAll(async () => {
      received = [];
      receiver = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));

      // A vendor-authored SLACK template — same shape seed-notification-templates.ts
      // already uses for every other channel, seeded ad hoc here rather than
      // touching that seed file (this codebase's own "test-specific fixtures
      // without editing seed files" convention — see payroll.md).
      await prisma.notificationTemplate.upsert({
        where: { eventType_channel_locale_version: { eventType: 'workflow.approved', channel: 'SLACK', locale: 'en', version: 1 } },
        create: { eventType: 'workflow.approved', channel: 'SLACK', locale: 'en', version: 1, isActive: true, body: 'Workflow approved.' },
        update: {},
      });

      const port = (receiver.address() as AddressInfo).port;
      await prisma.slackWorkspaceConfig.upsert({
        where: { tenantId },
        create: { tenantId, webhookUrlEncrypted: 'placeholder', enabled: true },
        update: { enabled: true },
      });
      // Encrypt via the app's own EncryptionService rather than hand-rolling
      // the cipher format here.
      const encryption = moduleRef.get(EncryptionService);
      await prisma.slackWorkspaceConfig.update({
        where: { tenantId },
        data: { webhookUrlEncrypted: encryption.encrypt(`http://127.0.0.1:${port}/slack-hook`) },
      });

      // Opt this admin user into SLACK for workflow.approved (absent from
      // DEFAULT_NOTIFICATION_CHANNELS — opt-in only, per NotificationChannel's
      // own doc comment).
      await prisma.notificationPreference.upsert({
        where: { tenantId_userId_eventType_channel: { tenantId, userId: adminUserId, eventType: 'workflow.approved', channel: 'SLACK' } },
        create: { tenantId, userId: adminUserId, eventType: 'workflow.approved', channel: 'SLACK', enabled: true },
        update: { enabled: true },
      });
    });

    afterAll(() => {
      receiver.close();
    });

    it('a real workflow.approved event routes a Slack notification through the provider seam to the configured webhook', async () => {
      const template = await prisma.workflowTemplate.create({
        data: { tenantId, name: 'SLACK_TEST', entityType: 'SLACK_TEST', version: 1, isActive: true },
      });
      await prisma.workflowStep.create({
        data: { tenantId, templateId: template.id, name: 'Self-approval', order: 1, approverRule: { type: 'SPECIFIC_USER', userId: adminUserId } },
      });

      const start = await request(app.getHttpServer())
        .post('/workflow/instances')
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entityType: 'SLACK_TEST', entityId: 'slack-test-1', dataSnapshot: {} })
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/workflow/instances/${start.body.id}`)
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const step = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');

      await request(app.getHttpServer())
        .post(`/workflow/instances/${start.body.id}/steps/${step.id}/actions`)
        .set('Host', hostFor(TENANT_SLUG))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ actionType: 'APPROVE' })
        .expect(201);

      await waitFor(async () => (received.length > 0 ? received : null));
      expect(received[0].text).toContain('Workflow approved.');
    }, 15000);
  });
});
