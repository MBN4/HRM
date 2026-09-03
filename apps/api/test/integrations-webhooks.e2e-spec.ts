/**
 * Proves outbound webhooks (step 3.3) end to end over real HTTP — see
 * docs/conventions/integrations.md: a real domain event (a workflow
 * approval) fires a signed, HMAC-verifiable delivery to a subscribed local
 * HTTP receiver via the real BullMQ pipeline; a subscription filtered to a
 * DIFFERENT event type or PAUSED never delivers; a permanently-failing
 * receiver trips its OWN circuit breaker and dead-letters without ever
 * affecting another subscription; subscription management is
 * `webhook.manage`-gated (TENANT_ADMIN only) and `FEATURE_FLAGS.WEBHOOKS`-
 * gated; and none of it crosses tenants (RLS).
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
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import type { ApproverRule } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { CircuitBreakerService } from '../src/resilience/circuit-breaker/circuit-breaker.service';
import { verifyWebhookSignature } from '../src/integrations/webhooks/webhook-signature.util';
import { WebhookDeliveryService } from '../src/integrations/webhooks/webhook-delivery.service';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const TENANT_A_SLUG = 'int-webhook-tenant-a';
const TENANT_B_SLUG = 'int-webhook-tenant-b';
const ENTITY_TYPE = 'WEBHOOK_TEST_ENTITY';

const jwt = new JwtService({ secret: process.env.JWT_SECRET });
const SPECIFIC = (userId: string): ApproverRule => ({ type: 'SPECIFIC_USER', userId });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
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

interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

/** A tiny local HTTP receiver — the "subscribed endpoint" every delivery test posts to. `status` is mutable so a test can flip it into a permanent failure. */
function startReceiver(): { server: Server; received: ReceivedRequest[]; status: { code: number } } {
  const received: ReceivedRequest[] = [];
  const status = { code: 200 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status.code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status.code < 300 }));
    });
  });
  return { server, received, status };
}

describe('integrations — outbound webhooks (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let tenantBId: string;
  let adminTokenA: string;
  let adminTokenB: string;
  let employeeTokenA: string;
  let adminAId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await resetFixtures();

    const tenantA = await prisma.tenant.create({
      data: { name: 'Integrations Webhook Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Integrations Webhook Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await seedSystemRolesAndPermissions(prisma, tenantAId);
    await seedSystemRolesAndPermissions(prisma, tenantBId);

    // PROFESSIONAL — FEATURE_FLAGS.WEBHOOKS is a PROFESSIONAL+ flag (3.3).
    await prisma.subscription.create({ data: { tenantId: tenantAId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { tenantId: tenantBId, edition: 'PROFESSIONAL', status: 'ACTIVE' } });

    const adminARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const employeeARole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantAId, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const adminBRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantBId, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });

    const adminA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'admin@int-webhook-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: adminA.id, roleId: adminARole.id } });
    adminTokenA = jwt.sign({ sub: adminA.id, tenantId: tenantAId });
    adminAId = adminA.id;

    const employeeA = await prisma.user.create({
      data: { tenantId: tenantAId, email: 'employee@int-webhook-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: employeeA.id, roleId: employeeARole.id } });
    employeeTokenA = jwt.sign({ sub: employeeA.id, tenantId: tenantAId });

    const adminB = await prisma.user.create({
      data: { tenantId: tenantBId, email: 'admin@int-webhook-b.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: adminB.id, roleId: adminBRole.id } });
    adminTokenB = jwt.sign({ sub: adminB.id, tenantId: tenantBId });

    // A single-step, self-approvable workflow template — the SAME
    // `SPECIFIC_USER` approver-rule shape workflow.e2e-spec.ts's own
    // fixtures already establish. Real `workflow.submitted`/
    // `workflow.approved` events, not synthetic ones.
    const template = await prisma.workflowTemplate.create({
      data: { tenantId: tenantAId, name: ENTITY_TYPE, entityType: ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantAId, templateId: template.id, name: 'Self-approval', order: 1, approverRule: SPECIFIC(adminAId) },
    });

    const templateB = await prisma.workflowTemplate.create({
      data: { tenantId: tenantBId, name: ENTITY_TYPE, entityType: ENTITY_TYPE, version: 1, isActive: true },
    });
    await prisma.workflowStep.create({
      data: { tenantId: tenantBId, templateId: templateB.id, name: 'Self-approval', order: 1, approverRule: SPECIFIC(adminB.id) },
    });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function createSubscription(token: string, tenantSlug: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/integrations/webhooks/subscriptions')
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function listDeliveries(token: string, tenantSlug: string, subscriptionId: string) {
    return request(app.getHttpServer())
      .get(`/integrations/webhooks/subscriptions/${subscriptionId}/deliveries`)
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`);
  }

  /** Starts + immediately self-approves a real WorkflowInstance for the given tenant — emits real `workflow.submitted` then `workflow.approved` events. */
  async function approveOneInstance(token: string, tenantSlug: string, tenantId: string, approverId: string, entityId: string) {
    const start = await request(app.getHttpServer())
      .post('/workflow/instances')
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .send({ entityType: ENTITY_TYPE, entityId, dataSnapshot: {} })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/workflow/instances/${start.body.id}`)
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const step = detail.body.steps.find((s: { status: string }) => s.status === 'ACTIVE');

    await request(app.getHttpServer())
      .post(`/workflow/instances/${start.body.id}/steps/${step.id}/actions`)
      .set('Host', hostFor(tenantSlug))
      .set('Authorization', `Bearer ${token}`)
      .send({ actionType: 'APPROVE' })
      .expect(201);

    return start.body.id as string;
  }

  it('RBAC deny-by-default: a non-admin cannot create a webhook subscription', async () => {
    await createSubscription(employeeTokenA, TENANT_A_SLUG, { url: 'https://example.test/hook', eventTypes: ['workflow.approved'] }).expect(
      403,
    );
  });

  it('feature-flag gated: a tenant without the WEBHOOKS flag cannot create a subscription', async () => {
    const starterTenant = await prisma.tenant.create({
      data: { name: 'Webhook Starter Tenant', slug: 'int-webhook-starter', defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    await seedSystemRolesAndPermissions(prisma, starterTenant.id);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: starterTenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
    });
    const user = await prisma.user.create({
      data: { tenantId: starterTenant.id, email: 'admin@int-webhook-starter.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: starterTenant.id, userId: user.id, roleId: role.id } });
    const token = jwt.sign({ sub: user.id, tenantId: starterTenant.id });
    // No subscription at all -> STARTER-equivalent (empty flag set).

    await createSubscription(token, 'int-webhook-starter', { url: 'https://example.test/hook', eventTypes: ['workflow.approved'] }).expect(
      403,
    );
    await prisma.tenant.delete({ where: { id: starterTenant.id } });
  });

  it('an event fires -> a signed delivery reaches the subscribed endpoint, verified via HMAC, and the delivery log records it', async () => {
    const receiver = startReceiver();
    await new Promise<void>((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
    const port = (receiver.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/hook`;

    const created = await createSubscription(adminTokenA, TENANT_A_SLUG, { url, eventTypes: ['workflow.approved'] }).expect(201);
    const signingSecret: string = created.body.signingSecret;
    expect(signingSecret.startsWith('whsec_')).toBe(true);

    await approveOneInstance(adminTokenA, TENANT_A_SLUG, tenantAId, adminAId, 'webhook-happy-path-1');

    await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { tenantId: tenantAId, webhookSubscriptionId: created.body.id, status: 'SUCCEEDED' },
      });
      return row;
    });

    expect(receiver.received.length).toBeGreaterThanOrEqual(1);
    const delivered = receiver.received[0];
    const signatureHeader = delivered.headers['x-hrm-signature'] as string;
    expect(signatureHeader).toBeDefined();
    expect(verifyWebhookSignature(signingSecret, signatureHeader, delivered.rawBody)).toBe(true);
    // A tampered body must NOT verify.
    expect(verifyWebhookSignature(signingSecret, signatureHeader, `${delivered.rawBody}tampered`)).toBe(false);

    const envelope = JSON.parse(delivered.rawBody);
    expect(envelope.eventType).toBe('workflow.approved');
    expect(envelope.tenantId).toBe(tenantAId);

    const deliveries = await listDeliveries(adminTokenA, TENANT_A_SLUG, created.body.id).expect(200);
    expect(deliveries.body[0]).toMatchObject({ status: 'SUCCEEDED', lastResponseStatus: 200 });
    expect(deliveries.body[0].attempts).toBeGreaterThanOrEqual(1);

    receiver.server.close();
  }, 20000);

  it('a subscription filtered to a different event type never receives an unrelated event', async () => {
    const receiver = startReceiver();
    await new Promise<void>((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
    const port = (receiver.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/hook`;

    // Subscribed to an event this flow never emits.
    const created = await createSubscription(adminTokenA, TENANT_A_SLUG, { url, eventTypes: ['payroll.payslip_ready'] }).expect(201);
    await approveOneInstance(adminTokenA, TENANT_A_SLUG, tenantAId, adminAId, 'webhook-filtered-1');

    // Give the (real) queue a moment, then assert nothing was ever created for THIS subscription.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = await prisma.webhookDelivery.findMany({ where: { webhookSubscriptionId: created.body.id } });
    expect(rows).toHaveLength(0);
    expect(receiver.received).toHaveLength(0);

    receiver.server.close();
  });

  it('a PAUSED subscription receives no new deliveries', async () => {
    const receiver = startReceiver();
    await new Promise<void>((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
    const port = (receiver.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/hook`;

    const created = await createSubscription(adminTokenA, TENANT_A_SLUG, { url, eventTypes: ['workflow.approved'] }).expect(201);
    await request(app.getHttpServer())
      .put(`/integrations/webhooks/subscriptions/${created.body.id}`)
      .set('Host', hostFor(TENANT_A_SLUG))
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ status: 'PAUSED' })
      .expect(200);

    await approveOneInstance(adminTokenA, TENANT_A_SLUG, tenantAId, adminAId, 'webhook-paused-1');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const rows = await prisma.webhookDelivery.findMany({ where: { webhookSubscriptionId: created.body.id } });
    expect(rows).toHaveLength(0);

    receiver.server.close();
  });

  it('a permanently-failing endpoint trips its OWN circuit breaker and dead-letters — without harming any other subscription', async () => {
    const failingReceiver = startReceiver();
    failingReceiver.status.code = 500;
    await new Promise<void>((resolve) => failingReceiver.server.listen(0, '127.0.0.1', resolve));
    const failingPort = (failingReceiver.server.address() as AddressInfo).port;
    const failingUrl = `http://127.0.0.1:${failingPort}/hook`;

    const healthyReceiver = startReceiver();
    await new Promise<void>((resolve) => healthyReceiver.server.listen(0, '127.0.0.1', resolve));
    const healthyPort = (healthyReceiver.server.address() as AddressInfo).port;
    const healthyUrl = `http://127.0.0.1:${healthyPort}/hook`;

    const failingSub = await createSubscription(adminTokenA, TENANT_A_SLUG, { url: failingUrl, eventTypes: ['workflow.approved'] }).expect(
      201,
    );
    const healthySub = await createSubscription(adminTokenA, TENANT_A_SLUG, { url: healthyUrl, eventTypes: ['workflow.approved'] }).expect(
      201,
    );

    const deliveryService = moduleRef.get(WebhookDeliveryService);
    const circuitBreaker = moduleRef.get(CircuitBreakerService);
    const breakerName = `webhook:${failingSub.body.id}`;
    await circuitBreaker.reset(breakerName);

    // DEFAULT_CIRCUIT_BREAKER_OPTIONS.failureThreshold is 5 — 5 independent,
    // real (not fast-failed) attempts trip it, calling WebhookDeliveryService
    // directly (bypassing BullMQ's own backoff timing) the SAME way
    // notifications.e2e-spec.ts proves its own retry/dead-letter state
    // machine deterministically.
    for (let i = 0; i < 5; i++) {
      const delivery = await prisma.webhookDelivery.create({
        data: {
          tenantId: tenantAId,
          webhookSubscriptionId: failingSub.body.id,
          eventType: 'workflow.approved',
          payload: { id: `trip-${i}`, eventType: 'workflow.approved', occurredAt: new Date().toISOString(), tenantId: tenantAId, data: {} },
          status: 'PENDING',
        },
      });
      // NOT `.rejects.toThrow()` — with maxAttempts:1, `deliver` treats this
      // as the FINAL attempt and resolves normally after recording
      // DEAD_LETTER (see WebhookDeliveryService's own doc comment); it only
      // re-throws when there are retries remaining for BullMQ to pick up.
      await deliveryService.deliver(tenantAId, delivery.id, 0, 1);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('DEAD_LETTER');
    }

    expect(await circuitBreaker.getState(breakerName)).toBe('OPEN');
    const attemptsBeforeTrip = failingReceiver.received.length;

    // The breaker is OPEN — this next delivery must fail FAST (no new HTTP
    // attempt reaches the receiver at all) and, since maxAttempts=1, dead-
    // letters immediately.
    const trippedDelivery = await prisma.webhookDelivery.create({
      data: {
        tenantId: tenantAId,
        webhookSubscriptionId: failingSub.body.id,
        eventType: 'workflow.approved',
        payload: { id: 'trip-final', eventType: 'workflow.approved', occurredAt: new Date().toISOString(), tenantId: tenantAId, data: {} },
        status: 'PENDING',
      },
    });
    await deliveryService.deliver(tenantAId, trippedDelivery.id, 0, 1);
    expect(failingReceiver.received.length).toBe(attemptsBeforeTrip);
    const finalRow = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: trippedDelivery.id } });
    expect(finalRow.status).toBe('DEAD_LETTER');

    // The healthy subscription's OWN breaker is completely unaffected —
    // proves one-breaker-per-subscription isolation, "doesn't harm the
    // system".
    await approveOneInstance(adminTokenA, TENANT_A_SLUG, tenantAId, adminAId, 'webhook-isolation-check');
    await waitFor(async () =>
      prisma.webhookDelivery.findFirst({ where: { webhookSubscriptionId: healthySub.body.id, status: 'SUCCEEDED' } }),
    );

    failingReceiver.server.close();
    healthyReceiver.server.close();
  }, 20000);

  it('cross-tenant: tenant B never receives tenant A deliveries, and cannot see or manage tenant A subscriptions (RLS)', async () => {
    const receiverA = startReceiver();
    await new Promise<void>((resolve) => receiverA.server.listen(0, '127.0.0.1', resolve));
    const portA = (receiverA.server.address() as AddressInfo).port;
    const subA = await createSubscription(adminTokenA, TENANT_A_SLUG, {
      url: `http://127.0.0.1:${portA}/hook`,
      eventTypes: ['workflow.approved'],
    }).expect(201);

    const receiverB = startReceiver();
    await new Promise<void>((resolve) => receiverB.server.listen(0, '127.0.0.1', resolve));
    const portB = (receiverB.server.address() as AddressInfo).port;
    await createSubscription(adminTokenB, TENANT_B_SLUG, {
      url: `http://127.0.0.1:${portB}/hook`,
      eventTypes: ['workflow.approved'],
    }).expect(201);

    await approveOneInstance(adminTokenA, TENANT_A_SLUG, tenantAId, adminAId, 'webhook-cross-tenant-1');
    await waitFor(async () => prisma.webhookDelivery.findFirst({ where: { webhookSubscriptionId: subA.body.id, status: 'SUCCEEDED' } }));

    // Tenant B's receiver never got tenant A's event.
    expect(receiverB.received).toHaveLength(0);

    // Tenant B cannot list tenant A's subscription, nor its deliveries — RLS.
    const listB = await request(app.getHttpServer())
      .get('/integrations/webhooks/subscriptions')
      .set('Host', hostFor(TENANT_B_SLUG))
      .set('Authorization', `Bearer ${adminTokenB}`)
      .expect(200);
    expect(listB.body.some((s: { id: string }) => s.id === subA.body.id)).toBe(false);

    const deliveriesFromB = await listDeliveries(adminTokenB, TENANT_B_SLUG, subA.body.id).expect(200);
    expect(deliveriesFromB.body).toHaveLength(0);

    receiverA.server.close();
    receiverB.server.close();
  }, 20000);
});
