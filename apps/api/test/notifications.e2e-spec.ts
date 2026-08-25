/**
 * Proves the notifications hub (0.8) end to end over real HTTP: password
 * reset routed through the hub (replacing 0.4's dev-log stub), async
 * delivery decoupled from the triggering request, recipient-locale-driven
 * template rendering (a US branch recipient vs. a Qatar branch recipient),
 * per-user channel preferences suppressing a channel, a workflow event
 * producing an in-app notification that persists/mark-reads and is
 * tenant-isolated (RLS), and the retry-then-dead-letter state machine.
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
import {
  appPrisma,
  prisma,
  seedCountryPacks,
  seedNotificationTemplates,
  seedSystemRolesAndPermissions,
  SYSTEM_ROLES,
} from '@hrm/db';
import type { NotificationProvider } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { NotificationDeliveryService } from '../src/notifications/notification-delivery.service';
import { EMAIL_PROVIDER } from '../src/notifications/providers/notification-provider.tokens';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'notif-test-tenant-a';
const TENANT_B_SLUG = 'notif-test-tenant-b';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 6000, intervalMs = 100): Promise<T> {
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

describe('notifications hub (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let employeeRoleAId: string;

  let usUserId: string;
  let usUserEmail: string;
  let qaUserId: string;
  let qaUserEmail: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();
    await seedCountryPacks(prisma);
    await seedNotificationTemplates(prisma);

    const tenantA = await prisma.tenant.create({
      data: { name: 'Notif Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Notif Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    const employeeRoleA = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    employeeRoleAId = employeeRoleA.id;

    const usBranch = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Notif US Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    const qaBranch = await prisma.branch.create({
      data: { tenantId: tenantAId, name: 'Notif QA Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });

    const makeUser = async (email: string, branchId: string) => {
      const user = await prisma.user.create({
        data: { tenantId: tenantAId, email, hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: user.id, roleId: employeeRoleAId } });
      await prisma.userBranch.create({ data: { tenantId: tenantAId, userId: user.id, branchId } });
      return user;
    };

    const usUser = await makeUser('us-recipient@notif-a.test', usBranch.id);
    usUserId = usUser.id;
    usUserEmail = usUser.email;
    const qaUser = await makeUser('qa-recipient@notif-a.test', qaBranch.id);
    qaUserId = qaUser.id;
    qaUserEmail = qaUser.email;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function requestPasswordReset(email: string) {
    return request(app.getHttpServer())
      .post('/auth/request-password-reset')
      .set('Host', hostFor(TENANT_A_SLUG))
      .send({ email });
  }

  async function deliveriesFor(recipientUserId: string, eventType: string) {
    return prisma.notificationDelivery.findMany({
      where: { notification: { tenantId: tenantAId, recipientUserId, eventType } },
      orderBy: { createdAt: 'asc' },
    });
  }

  describe('password reset routes through the hub, localized per recipient', () => {
    it('a US-branch recipient gets an English EMAIL + IN_APP notification', async () => {
      await requestPasswordReset(usUserEmail).expect(204);

      const delivered = await waitFor(async () => {
        const rows = await deliveriesFor(usUserId, 'auth.password_reset_requested');
        return rows.length >= 2 && rows.every((r) => r.status === 'SENT') ? rows : null;
      });

      const email = delivered.find((d) => d.channel === 'EMAIL')!;
      const inApp = delivered.find((d) => d.channel === 'IN_APP')!;
      expect(email.renderedBody).toMatch(/password reset was requested/i);
      expect(inApp.renderedBody).toMatch(/password reset was requested/i);
    });

    it('a Qatar-branch recipient gets the SAME event rendered in Arabic', async () => {
      await requestPasswordReset(qaUserEmail).expect(204);

      const delivered = await waitFor(async () => {
        const rows = await deliveriesFor(qaUserId, 'auth.password_reset_requested');
        return rows.length >= 2 && rows.every((r) => r.status === 'SENT') ? rows : null;
      });

      const email = delivered.find((d) => d.channel === 'EMAIL')!;
      expect(email.renderedBody).toContain('إعادة تعيين');
      expect(email.renderedBody).not.toMatch(/password reset was requested/i);
    });
  });

  describe('delivery is asynchronous — the request never waits on the provider', () => {
    let slowApp: INestApplication;
    let slowModuleRef: TestingModule;
    const SLOW_PROVIDER_DELAY_MS = 2500;

    beforeAll(async () => {
      const slowEmailProvider: NotificationProvider = {
        send: () => new Promise((resolve) => setTimeout(resolve, SLOW_PROVIDER_DELAY_MS)),
      };
      slowModuleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_PROVIDER)
        .useValue(slowEmailProvider)
        .compile();
      slowApp = slowModuleRef.createNestApplication();
      await slowApp.init();
    });

    afterAll(async () => {
      await slowModuleRef.get<IORedis>(REDIS_CLIENT).quit();
      await slowApp.close();
    });

    it('the HTTP response returns almost immediately even though the EMAIL provider takes seconds', async () => {
      const user = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'async-check@notif-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });

      const startedAt = Date.now();
      await request(slowApp.getHttpServer())
        .post('/auth/request-password-reset')
        .set('Host', hostFor(TENANT_A_SLUG))
        .send({ email: user.email })
        .expect(204);
      const elapsedMs = Date.now() - startedAt;

      // Well under the provider's artificial delay — the request cannot
      // have waited for it.
      expect(elapsedMs).toBeLessThan(SLOW_PROVIDER_DELAY_MS);

      // ...and delivery still completes shortly after, proving the work
      // actually happens, just not on the request's call stack.
      const sent = await waitFor(async () => {
        const rows = await deliveriesFor(user.id, 'auth.password_reset_requested');
        const email = rows.find((r) => r.channel === 'EMAIL');
        return email?.status === 'SENT' ? email : null;
      }, SLOW_PROVIDER_DELAY_MS + 3000);
      expect(sent.status).toBe('SENT');
    });
  });

  describe('per-user preferences suppress a channel', () => {
    it('disabling EMAIL for an event type leaves only the other default channel delivered', async () => {
      const user = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'pref-check@notif-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      const token = jwt.sign({ sub: user.id, tenantId: tenantAId });

      await request(app.getHttpServer())
        .put('/notifications/preferences')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${token}`)
        .send({ preferences: [{ eventType: 'auth.password_reset_requested', channel: 'EMAIL', enabled: false }] })
        .expect(200);

      await requestPasswordReset(user.email).expect(204);

      const inApp = await waitFor(async () => {
        const rows = await deliveriesFor(user.id, 'auth.password_reset_requested');
        const row = rows.find((r) => r.channel === 'IN_APP');
        return row?.status === 'SENT' ? row : null;
      });
      expect(inApp).toBeDefined();

      // Give any (incorrectly) enqueued EMAIL job a moment it would have
      // needed, then confirm it was never created at all.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rows = await deliveriesFor(user.id, 'auth.password_reset_requested');
      expect(rows.some((r) => r.channel === 'EMAIL')).toBe(false);
    });
  });

  describe('workflow events produce in-app notifications (persisted, mark-read, tenant-isolated)', () => {
    it('the eligible approver sees a workflow.submitted notification, can mark it read, and tenant B cannot', async () => {
      const requester = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'wf-requester@notif-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: requester.id, roleId: employeeRoleAId } });
      const approver = await prisma.user.create({
        data: { tenantId: tenantAId, email: 'wf-approver@notif-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: approver.id, roleId: employeeRoleAId } });

      const template = await prisma.workflowTemplate.create({
        data: { tenantId: tenantAId, name: 'NOTIF_DEMO', entityType: 'NOTIF_DEMO', version: 1, isActive: true },
      });
      await prisma.workflowStep.create({
        data: {
          tenantId: tenantAId,
          templateId: template.id,
          name: 'Approval',
          order: 1,
          approverRule: { type: 'SPECIFIC_USER', userId: approver.id },
        },
      });

      const requesterToken = jwt.sign({ sub: requester.id, tenantId: tenantAId });
      const approverToken = jwt.sign({ sub: approver.id, tenantId: tenantAId });

      await request(app.getHttpServer())
        .post('/workflow/instances')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${requesterToken}`)
        .send({ entityType: 'NOTIF_DEMO', entityId: 'notif-demo-1', dataSnapshot: {} })
        .expect(201);

      const list = await waitFor(async () => {
        const res = await request(app.getHttpServer())
          .get('/notifications')
          .set('Host', hostFor(TENANT_A_SLUG))
          .set('Authorization', `Bearer ${approverToken}`)
          .expect(200);
        const match = (res.body as Array<{ eventType: string; delivery: { id: string; status: string } }>).find(
          (n) => n.eventType === 'workflow.submitted',
        );
        return match?.delivery.status === 'SENT' ? match : null;
      });
      const deliveryId = list.delivery.id;

      const readRes = await request(app.getHttpServer())
        .post(`/notifications/${deliveryId}/read`)
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${approverToken}`)
        .expect(201);
      expect(readRes.body.readAt).not.toBeNull();

      // Cross-tenant: a tenant-B caller resolves under tenant B's RLS
      // context, so the same delivery id is simply not visible to them.
      const tenantBUser = await prisma.user.create({
        data: { tenantId: tenantBId, email: 'wf-crosscheck@notif-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      const tenantBToken = jwt.sign({ sub: tenantBUser.id, tenantId: tenantBId });
      await request(app.getHttpServer())
        .post(`/notifications/${deliveryId}/read`)
        .set('Host', hostFor(TENANT_B_SLUG))
        .set('Authorization', `Bearer ${tenantBToken}`)
        .expect(404);
    });
  });

  describe('retry then dead-letter', () => {
    it('a delivery whose template is missing FAILS with retries remaining, then DEAD_LETTERs on the final attempt', async () => {
      const notification = await prisma.notification.create({
        data: {
          tenantId: tenantAId,
          recipientUserId: usUserId,
          eventType: 'workflow.submitted',
          // SMS has no seeded template for workflow.submitted (or a
          // fallback "en" one) — deliberately, so rendering fails for a
          // real reason rather than a mocked one.
          payload: { instanceId: 'x', entityType: 'DEMO', entityId: 'y' },
        },
      });
      const delivery = await prisma.notificationDelivery.create({
        data: { tenantId: tenantAId, notificationId: notification.id, channel: 'SMS', status: 'PENDING' },
      });

      const deliveryService = moduleRef.get(NotificationDeliveryService);

      // Attempt 1 of 3 — retries remain, so the service re-throws for
      // BullMQ to schedule a retry, having already recorded the failure.
      await expect(deliveryService.deliver(tenantAId, delivery.id, 0, 3)).rejects.toThrow();
      let current = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(current.status).toBe('FAILED');
      expect(current.attempts).toBe(1);
      expect(current.lastError).toBeTruthy();

      // Attempt 3 of 3 (attemptsMade=2 -> this is the final attempt) —
      // dead-lettered, and NOT re-thrown (no further retry is scheduled).
      await expect(deliveryService.deliver(tenantAId, delivery.id, 2, 3)).resolves.toBeUndefined();
      current = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(current.status).toBe('DEAD_LETTER');
      expect(current.attempts).toBe(2);
    });
  });
});
