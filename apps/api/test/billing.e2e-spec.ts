/**
 * Proves SaaS billing (step 4.2) end to end over real HTTP — see
 * docs/conventions/billing.md: seat metering (active-user count drives the
 * plan preview and the billed quantity), a plan change computing a
 * Decimal-safe proration preview, the REAL subscription-state ->
 * entitlement path now driven by signed inbound Stripe webhooks (not a
 * hand-written DB row) — active enables edition flags, past_due disables
 * them, a fully canceled subscription suspends the tenant exactly like
 * 4.1's tenant-suspension enforcement — signature verification, a
 * REDELIVERED webhook not double-applying, a multi-currency invoice
 * recorded Decimal-correct, the vendor console's billing oversight
 * (read-only for PLATFORM_SUPPORT, AMC invoicing for PLATFORM_OWNER, never
 * touching the License table), and cross-tenant isolation throughout.
 *
 * `PLATFORM_MODE_ENABLED` is forced on here (before the Nest app is
 * compiled) to exercise the vendor console's own billing routes — the same
 * per-file pattern every other platform-touching e2e file in this suite
 * already takes.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.PLATFORM_MODE_ENABLED = 'true';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type IORedis from 'ioredis';
import { appPrisma, prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { EDITION_FEATURES } from '@hrm/shared';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { signWebhookPayload } from '../src/integrations/webhooks/webhook-signature.util';
import { createTestPlatformAdmin, cleanupTestPlatformAdmins } from './helpers/platform-test-auth';

const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'yourhrms.local';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev_local_only_do_not_use_in_prod';

const TENANT_A_SLUG = 'billing-tenant-a';
const TENANT_B_SLUG = 'billing-tenant-b';
const TENANT_C_SLUG = 'billing-tenant-c'; // dedicated: gets suspended by its own test, unusable afterward

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG, TENANT_C_SLUG] } } });
  await cleanupTestPlatformAdmins();
}

function hostFor(slug: string) {
  return `${slug}.${BASE_DOMAIN}`;
}

async function createTenantWithAdmin(slug: string, name: string) {
  const tenant = await prisma.tenant.create({
    data: { name, slug, defaultCountryCode: 'US', hostingRegion: 'us-east-1', edition: 'STARTER' },
  });
  await seedSystemRolesAndPermissions(prisma, tenant.id);
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
  });
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email: `admin@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
  });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id } });
  const employeeRole = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.EMPLOYEE } },
  });
  const employee = await prisma.user.create({
    data: { tenantId: tenant.id, email: `employee@${slug}.test`, hashedPassword: 'unused', status: 'ACTIVE' },
  });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: employee.id, roleId: employeeRole.id } });

  return {
    tenantId: tenant.id,
    adminToken: jwt.sign({ sub: admin.id, tenantId: tenant.id }),
    employeeToken: jwt.sign({ sub: employee.id, tenantId: tenant.id }),
  };
}

/** Builds a fake Stripe webhook payload in Stripe's own raw (snake_case) shape — see StripeWebhookService's parse* helpers for exactly which fields are read. */
function subscriptionEventPayload(opts: {
  type: string;
  customerId: string;
  subscriptionId?: string;
  status: string;
  priceId?: string;
  quantity?: number;
  cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: `evt_${randomUUID()}`,
    type: opts.type,
    data: {
      object: {
        id: opts.subscriptionId ?? `sub_${randomUUID()}`,
        customer: opts.customerId,
        status: opts.status,
        currency: 'usd',
        items: { data: [{ price: { id: opts.priceId ?? 'price_mock_professional' }, quantity: opts.quantity ?? 5 }] },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        trial_end: null,
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
      },
    },
  };
}

function invoiceEventPayload(opts: {
  type: string;
  customerId: string;
  invoiceId?: string;
  status: string;
  currency: string;
  amountDueMinorUnits: number;
  amountPaidMinorUnits?: number;
}) {
  return {
    id: `evt_${randomUUID()}`,
    type: opts.type,
    data: {
      object: {
        id: opts.invoiceId ?? `in_${randomUUID()}`,
        customer: opts.customerId,
        status: opts.status,
        currency: opts.currency,
        amount_due: opts.amountDueMinorUnits,
        amount_paid: opts.amountPaidMinorUnits ?? 0,
        amount_remaining: opts.amountDueMinorUnits - (opts.amountPaidMinorUnits ?? 0),
        description: 'Test invoice',
        hosted_invoice_url: 'https://mock.stripe.local/hosted',
        invoice_pdf: 'https://mock.stripe.local/pdf',
      },
    },
  };
}

describe('billing (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  let tenantAId: string;
  let adminTokenA: string;
  let employeeTokenA: string;

  let tenantBId: string;
  let adminTokenB: string;

  let tenantCId: string;
  let adminTokenC: string;

  let platformOwnerToken: string;
  let platformSupportToken: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    await resetFixtures();

    const a = await createTenantWithAdmin(TENANT_A_SLUG, 'Billing Tenant A');
    tenantAId = a.tenantId;
    adminTokenA = a.adminToken;
    employeeTokenA = a.employeeToken;

    const b = await createTenantWithAdmin(TENANT_B_SLUG, 'Billing Tenant B');
    tenantBId = b.tenantId;
    adminTokenB = b.adminToken;

    const c = await createTenantWithAdmin(TENANT_C_SLUG, 'Billing Tenant C');
    tenantCId = c.tenantId;
    adminTokenC = c.adminToken;

    platformOwnerToken = (await createTestPlatformAdmin('PLATFORM_OWNER')).token;
    platformSupportToken = (await createTestPlatformAdmin('PLATFORM_SUPPORT')).token;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  function summary(slug: string, token: string) {
    return request(app.getHttpServer()).get('/billing/summary').set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`);
  }

  function stripeWebhook(payload: unknown) {
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(WEBHOOK_SECRET, timestamp, rawBody);
    return request(app.getHttpServer())
      .post('/billing/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(rawBody);
  }

  describe('tenant billing summary + seat metering', () => {
    it('billing.manage is required — a non-admin user is denied', async () => {
      await summary(TENANT_A_SLUG, employeeTokenA).expect(403);
    });

    it('creates a TRIAL subscription + Stripe customer on first read, and meters the current active-user count as seats', async () => {
      const res = await summary(TENANT_A_SLUG, adminTokenA).expect(200);
      expect(res.body.subscription.status).toBe('TRIAL');
      // adminA + employeeA = 2 ACTIVE users already seeded.
      expect(res.body.activeSeats).toBe(2);

      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      expect(subscription.stripeCustomerId).toMatch(/^cus_mock_/);
    });

    it('activeSeats increases as more ACTIVE users are added', async () => {
      await prisma.user.create({
        data: { tenantId: tenantAId, email: 'third@billing-tenant-a.test', hashedPassword: 'unused', status: 'ACTIVE' },
      });
      const res = await summary(TENANT_A_SLUG, adminTokenA).expect(200);
      expect(res.body.activeSeats).toBe(3);
    });
  });

  describe('plan changes compute a Decimal-safe proration preview', () => {
    it('upgrading from STARTER to PROFESSIONAL bills for the current seat count and returns a numeric proration preview', async () => {
      const res = await request(app.getHttpServer())
        .post('/billing/plan')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ edition: 'PROFESSIONAL' })
        .expect(201);

      expect(res.body.subscription.edition).toBe('PROFESSIONAL');
      expect(res.body.subscription.quantity).toBe(3);
      // A brand-new (never-before-Stripe) subscription is a `create`, not a
      // proration-eligible `update` — MockStripeClient never sets
      // `latestProrationAmountMinorUnits` for `subscriptions.create`, so
      // BillingService's own PREVIEW (computeProrationPreviewMinorUnits)
      // is what the response carries here. Either way it must be a
      // finite, parseable integer string — never `NaN`/a float artifact.
      expect(Number.isFinite(Number(res.body.prorationPreviewMinorUnits))).toBe(true);

      const after = await summary(TENANT_A_SLUG, adminTokenA).expect(200);
      expect(after.body.subscription.edition).toBe('PROFESSIONAL');
      expect(after.body.subscription.quantity).toBe(3);
    });

    it('a subsequent downgrade prorates NEGATIVE (a credit), computed via Prisma.Decimal end to end', async () => {
      const res = await request(app.getHttpServer())
        .post('/billing/plan')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ edition: 'STARTER' })
        .expect(201);

      expect(res.body.subscription.edition).toBe('STARTER');
      expect(Number(res.body.prorationPreviewMinorUnits)).toBeLessThan(0);

      // Restore PROFESSIONAL for the webhook tests below, which assume it.
      await request(app.getHttpServer())
        .post('/billing/plan')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ edition: 'PROFESSIONAL' })
        .expect(201);
    });
  });

  describe('inbound Stripe webhooks — the real subscription-state -> entitlement path', () => {
    it('rejects a delivery with an invalid signature', async () => {
      const payload = subscriptionEventPayload({ type: 'customer.subscription.updated', customerId: 'cus_mock_doesnotmatter', status: 'active' });
      await request(app.getHttpServer())
        .post('/billing/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1,v1=deadbeef')
        .send(JSON.stringify(payload))
        .expect(400);
    });

    it('an unmatched Stripe customer id is acknowledged (200) and recorded to the platform trail, never crashes', async () => {
      const payload = subscriptionEventPayload({ type: 'customer.subscription.updated', customerId: 'cus_mock_unknown_nobody', status: 'active' });
      await stripeWebhook(payload).expect(200);

      const logged = await prisma.platformAuditLog.findFirst({
        where: { action: 'billing.unmatched_webhook_event', entityId: payload.id },
      });
      expect(logged).not.toBeNull();
    });

    it('customer.subscription.updated (active) is exactly the entitlement source — PROFESSIONAL flags now resolve for real', async () => {
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      const payload = subscriptionEventPayload({
        type: 'customer.subscription.updated',
        customerId: subscription.stripeCustomerId!,
        // Reuses the SAME Stripe subscription id the earlier interactive
        // `POST /billing/plan` call already created in MockStripeClient's
        // own store — exactly what a REAL Stripe webhook would always
        // carry (Stripe is authoritative; it never invents a new
        // subscription id out of nowhere). A later interactive call
        // (`changePlan`) that tries to `.update()` this same id must still
        // find it.
        subscriptionId: subscription.stripeSubscriptionId ?? undefined,
        status: 'active',
        priceId: 'price_mock_professional',
        quantity: 3,
      });
      await stripeWebhook(payload).expect(200);

      const entitlements = await request(app.getHttpServer())
        .get('/licensing/entitlements')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(entitlements.body.edition).toBe('PROFESSIONAL');
      expect(entitlements.body.blocked).toBe(false);
      expect(entitlements.body.flags.sort()).toEqual([...EDITION_FEATURES.PROFESSIONAL].sort());
    });

    it('a REDELIVERED webhook (same event id) does NOT double-apply', async () => {
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      const payload = subscriptionEventPayload({
        type: 'customer.subscription.updated',
        customerId: subscription.stripeCustomerId!,
        subscriptionId: subscription.stripeSubscriptionId ?? undefined,
        status: 'active',
        priceId: 'price_mock_professional',
        quantity: 7,
      });

      await stripeWebhook(payload).expect(200);
      await stripeWebhook(payload).expect(200); // identical event id, redelivered

      const billingEventCount = await prisma.billingEvent.count({ where: { tenantId: tenantAId, stripeEventId: payload.id } });
      expect(billingEventCount).toBe(1);

      const auditCount = await prisma.auditLog.count({
        where: { tenantId: tenantAId, metadata: { path: ['stripeEventId'], equals: payload.id } },
      });
      expect(auditCount).toBe(1);
    });

    it('customer.subscription.updated (past_due) disables every gated feature — the REAL check, not a stub', async () => {
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      const payload = subscriptionEventPayload({
        type: 'customer.subscription.updated',
        customerId: subscription.stripeCustomerId!,
        subscriptionId: subscription.stripeSubscriptionId ?? undefined,
        status: 'past_due',
        priceId: 'price_mock_professional',
      });
      await stripeWebhook(payload).expect(200);

      const entitlements = await request(app.getHttpServer())
        .get('/licensing/entitlements')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(entitlements.body.blocked).toBe(true);
      expect(entitlements.body.flags).toEqual([]);

      await request(app.getHttpServer())
        .get('/licensing/demo/advanced-reporting')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(403);

      // Still able to log in / manage billing — PAST_DUE gates FEATURES, it
      // does not suspend the tenant (see StripeWebhookService.handleSubscriptionDeleted's
      // own doc comment for why only a fully canceled subscription does).
      await summary(TENANT_A_SLUG, adminTokenA).expect(200);
    });

    it('customer.subscription.deleted (fully canceled) suspends the tenant — genuinely blocked, including further billing requests', async () => {
      // Uses its OWN dedicated tenant (C) since suspension makes every
      // further request to it 403, including this file's own cleanup path.
      await summary(TENANT_C_SLUG, adminTokenC).expect(200); // provisions the Stripe customer
      const subscriptionC = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantCId } });

      const payload = subscriptionEventPayload({
        type: 'customer.subscription.deleted',
        customerId: subscriptionC.stripeCustomerId!,
        status: 'canceled',
      });
      await stripeWebhook(payload).expect(200);

      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantCId } });
      expect(tenant.status).toBe('SUSPENDED');

      await summary(TENANT_C_SLUG, adminTokenC).expect(403);

      const tenantAudit = await prisma.auditLog.findFirst({
        where: { tenantId: tenantCId, action: 'billing.tenant_suspended_for_nonpayment' },
      });
      expect(tenantAudit).not.toBeNull();
      const platformAudit = await prisma.platformAuditLog.findFirst({
        where: { targetTenantId: tenantCId, action: 'billing.tenant_suspended_for_nonpayment' },
      });
      expect(platformAudit).not.toBeNull();
    });

    it('invoice.paid records a Decimal-correct MULTI-CURRENCY invoice', async () => {
      // Provision tenant B's Stripe customer first.
      await summary(TENANT_B_SLUG, adminTokenB).expect(200);
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantBId } });

      const payload = invoiceEventPayload({
        type: 'invoice.paid',
        customerId: subscription.stripeCustomerId!,
        status: 'paid',
        currency: 'eur',
        amountDueMinorUnits: 12345,
        amountPaidMinorUnits: 12345,
      });
      await stripeWebhook(payload).expect(200);

      const res = await summary(TENANT_B_SLUG, adminTokenB).expect(200);
      const matching = res.body.invoices.find((i: { currency: string; amountPaid: string }) => i.currency === 'eur');
      expect(matching).toBeDefined();
      expect(matching.amountPaid).toBe('123.45');
      expect(matching.status).toBe('PAID');
    });
  });

  describe('vendor console billing oversight', () => {
    it('PLATFORM_SUPPORT can read tenant billing but cannot create an AMC invoice', async () => {
      await request(app.getHttpServer())
        .get(`/platform/billing/tenants/${tenantBId}`)
        .set('Authorization', `Bearer ${platformSupportToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/platform/billing/tenants/${tenantBId}/amc-invoices`)
        .set('Authorization', `Bearer ${platformSupportToken}`)
        .send({ amountMinorUnits: 250000, currency: 'usd', description: 'Annual maintenance' })
        .expect(403);
    });

    it('PLATFORM_OWNER can create an invoice-only AMC charge — dual-audited, never touching the License table', async () => {
      const licensesBefore = await prisma.license.count({ where: { tenantId: tenantBId } });

      const res = await request(app.getHttpServer())
        .post(`/platform/billing/tenants/${tenantBId}/amc-invoices`)
        .set('Authorization', `Bearer ${platformOwnerToken}`)
        .send({ amountMinorUnits: 250000, currency: 'usd', description: 'Annual maintenance 2026' })
        .expect(201);

      expect(res.body.type).toBe('AMC');
      expect(res.body.subscriptionId).toBeNull();
      expect(res.body.amountDue).toBe('2500');

      const licensesAfter = await prisma.license.count({ where: { tenantId: tenantBId } });
      expect(licensesAfter).toBe(licensesBefore); // never touched

      const tenantAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantBId, action: 'billing.amc_invoice_created' } });
      expect(tenantAudit).not.toBeNull();
      const platformAudit = await prisma.platformAuditLog.findFirst({
        where: { targetTenantId: tenantBId, action: 'billing.amc_invoice_created' },
      });
      expect(platformAudit).not.toBeNull();
    });

    it('the platform-wide subscription list includes every tenant, not scoped to one', async () => {
      const res = await request(app.getHttpServer())
        .get('/platform/billing/subscriptions')
        .set('Authorization', `Bearer ${platformOwnerToken}`)
        .expect(200);
      const tenantIds = res.body.map((s: { tenantId: string }) => s.tenantId);
      expect(tenantIds).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });

    it('rejects a request with no platform admin token at all', async () => {
      await request(app.getHttpServer()).get('/platform/billing/subscriptions').expect(401);
    });
  });

  describe('cross-tenant isolation', () => {
    it("tenant A's plan/subscription changes never affect tenant B's", async () => {
      const bBefore = await summary(TENANT_B_SLUG, adminTokenB).expect(200);
      await request(app.getHttpServer())
        .post('/billing/plan')
        .set('Host', hostFor(TENANT_A_SLUG))
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ edition: 'ENTERPRISE' })
        .expect(201);

      const bAfter = await summary(TENANT_B_SLUG, adminTokenB).expect(200);
      expect(bAfter.body.subscription.edition).toBe(bBefore.body.subscription.edition);
    });

    it("a webhook event for tenant A's Stripe customer never touches tenant B's Subscription row", async () => {
      const subA = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantAId } });
      const bBefore = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantBId } });

      const payload = subscriptionEventPayload({
        type: 'customer.subscription.updated',
        customerId: subA.stripeCustomerId!,
        status: 'active',
        priceId: 'price_mock_enterprise',
      });
      await stripeWebhook(payload).expect(200);

      const bAfter = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenantBId } });
      expect(bAfter.status).toBe(bBefore.status);
      expect(bAfter.edition).toBe(bBefore.edition);
    });
  });
});
