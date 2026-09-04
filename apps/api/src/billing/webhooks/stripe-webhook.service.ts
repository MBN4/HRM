import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, prisma, withTenantContext } from '@hrm/db';
import { AuditRecordService } from '../../audit/audit-record.service';
import { PlatformAuditRecordService } from '../../platform/audit/platform-audit-record.service';
import { IdempotencyService } from '../../resilience/idempotency/idempotency.service';
import { BILLING_EVENTS } from '../billing-events';
import { BillingService } from '../billing.service';
import { STRIPE_CLIENT, StripeClient, StripeEvent, StripeSubscriptionStatus } from '../stripe/stripe-client.interface';
import { toDecimalFromMinorUnits } from '../money.util';

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

function readCustomerId(obj: Record<string, unknown>): string | null {
  const customer = obj.customer;
  if (typeof customer === 'string') {
    return customer;
  }
  if (customer && typeof customer === 'object' && typeof (customer as { id?: unknown }).id === 'string') {
    return (customer as { id: string }).id;
  }
  // customer.* events carry the customer id as the object's own `id`.
  return readString(obj, 'id');
}

function unixToDate(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

/**
 * Parses a Stripe `Subscription` object as it arrives in a webhook payload
 * (raw snake_case JSON, NOT the SDK's typed response) — a small, deliberate
 * duplicate of `RealStripeClient.toSubscription`'s mapping, justified the
 * same way `AccountingExportController`/every other adapter caller reads
 * its own row: one reads a rich, already-typed SDK response object, this
 * one reads an untyped webhook payload — the two inputs are genuinely
 * different shapes even though both originate from Stripe.
 */
function parseSubscriptionPayload(obj: Record<string, unknown>) {
  const items = obj.items as { data?: Array<{ price?: { id?: string }; quantity?: number }> } | undefined;
  const item = items?.data?.[0];
  return {
    id: readString(obj, 'id')!,
    customerId: readCustomerId(obj)!,
    status: readString(obj, 'status') as StripeSubscriptionStatus,
    priceId: item?.price?.id ?? '',
    quantity: item?.quantity ?? 1,
    currency: readString(obj, 'currency') ?? 'usd',
    currentPeriodEnd: unixToDate(obj.current_period_end) ?? new Date(),
    trialEnd: unixToDate(obj.trial_end),
    cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
  };
}

function parseInvoicePayload(obj: Record<string, unknown>) {
  return {
    id: readString(obj, 'id')!,
    customerId: readCustomerId(obj)!,
    status: (readString(obj, 'status') ?? 'draft') as 'draft' | 'open' | 'paid' | 'void' | 'uncollectible',
    currency: readString(obj, 'currency') ?? 'usd',
    amountDueMinorUnits: typeof obj.amount_due === 'number' ? obj.amount_due : 0,
    amountPaidMinorUnits: typeof obj.amount_paid === 'number' ? obj.amount_paid : 0,
    amountRemainingMinorUnits: typeof obj.amount_remaining === 'number' ? obj.amount_remaining : 0,
    description: readString(obj, 'description'),
    periodStart: unixToDate(obj.period_start),
    periodEnd: unixToDate(obj.period_end),
    dueDate: unixToDate(obj.due_date),
    hostedInvoiceUrl: readString(obj, 'hosted_invoice_url'),
    invoicePdfUrl: readString(obj, 'invoice_pdf'),
  };
}

function parsePaymentMethodPayload(obj: Record<string, unknown>) {
  const card = obj.card as { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | undefined;
  return {
    id: readString(obj, 'id')!,
    customerId: readCustomerId(obj)!,
    type: readString(obj, 'type') ?? 'card',
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
  };
}

/**
 * Processes INBOUND Stripe webhooks — step 4.2. See
 * docs/conventions/billing.md. This is the AUTHORITATIVE half of billing
 * state sync (`BillingService`'s own mutations apply Stripe's response
 * optimistically; this is what actually keeps `Subscription`/`Invoice`/
 * `PaymentMethod` correct over time, including for changes that happen
 * entirely on Stripe's side — a customer updating their card in the
 * Stripe-hosted portal, a dunning retry, ...).
 *
 * TWO idempotency layers, the SAME "no single layer trusted alone"
 * posture docs/conventions/payroll.md documents for `PayrollRunLine`:
 * `IdempotencyService` (Redis, `execute('stripe-webhook', event.id, fn)`)
 * is the fast path; `BillingEvent`'s own `@@unique([tenantId,
 * stripeEventId])` is the DB-level backstop — the FIRST write inside the
 * tenant transaction, so a `P2002` on a race (a Redis key that expired, a
 * process restart mid-flight) short-circuits the rest of `applyEvent`
 * before any Subscription/Invoice/PaymentMethod write happens twice.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    private readonly config: ConfigService,
    private readonly billing: BillingService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
    private readonly idempotency: IdempotencyService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async handleRawEvent(rawBody: string | Buffer, signatureHeader: string | undefined): Promise<void> {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not configured on this deployment.');
    }
    if (!signatureHeader) {
      throw new BadRequestException('Missing Stripe-Signature header.');
    }

    let event: StripeEvent;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
    } catch (error) {
      throw new BadRequestException(`Invalid Stripe webhook signature: ${String((error as Error).message ?? error)}`);
    }

    // `payment_method.detached`'s object has NO `customer` field in real
    // Stripe payloads (the method is no longer attached to anyone by the
    // time the event fires) — the one event type this codebase resolves
    // by a different key, our own PaymentMethod row's stripePaymentMethodId.
    const tenantId =
      event.type === 'payment_method.detached'
        ? await this.resolveTenantIdByPaymentMethod(readString(event.data.object, 'id'))
        : await this.resolveTenantIdByCustomer(readCustomerId(event.data.object));

    if (!tenantId) {
      const customerId = readCustomerId(event.data.object);
      this.logger.warn(`Stripe event "${event.id}" (${event.type}) did not resolve to any known tenant customer "${customerId}".`);
      await this.platformAudit.record({
        platformAdminId: null,
        action: 'billing.unmatched_webhook_event',
        entityType: 'BillingEvent',
        entityId: event.id,
        metadata: { eventType: event.type, customerId },
      });
      return;
    }

    await this.idempotency.execute(
      'stripe-webhook',
      event.id,
      () => withTenantContext(tenantId, (tx) => this.applyEvent(tx, tenantId, event)),
      7 * 24 * 60 * 60, // a week — comfortably longer than Stripe's own redelivery window
    );
  }

  private async resolveTenantIdByCustomer(stripeCustomerId: string | null): Promise<string | null> {
    if (!stripeCustomerId) {
      return null;
    }
    const subscription = await prisma.subscription.findUnique({ where: { stripeCustomerId }, select: { tenantId: true } });
    return subscription?.tenantId ?? null;
  }

  private async resolveTenantIdByPaymentMethod(stripePaymentMethodId: string | null): Promise<string | null> {
    if (!stripePaymentMethodId) {
      return null;
    }
    const paymentMethod = await prisma.paymentMethod.findUnique({ where: { stripePaymentMethodId }, select: { tenantId: true } });
    return paymentMethod?.tenantId ?? null;
  }

  private async applyEvent(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    try {
      await tx.billingEvent.create({ data: { tenantId, stripeEventId: event.id, eventType: event.type } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.log(`Stripe event "${event.id}" already processed for tenant "${tenantId}" — skipping (idempotent replay).`);
        return;
      }
      throw error;
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpsert(tx, tenantId, event);
        return;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(tx, tenantId, event);
        return;
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
        await this.handleInvoiceEvent(tx, tenantId, event);
        return;
      case 'payment_method.attached':
      case 'payment_method.updated':
        await this.handlePaymentMethodUpsert(tx, tenantId, event);
        return;
      case 'payment_method.detached':
        await this.handlePaymentMethodDetached(tx, tenantId, event);
        return;
      default:
        this.logger.debug(`Stripe event "${event.id}" (${event.type}) recorded, no handler — no-op.`);
    }
  }

  private async handleSubscriptionUpsert(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    const before = await tx.subscription.findUnique({ where: { tenantId } });
    const parsed = parseSubscriptionPayload(event.data.object);
    const updated = await this.billing.applySubscriptionFromStripe(tx, tenantId, before?.edition ?? 'STARTER', {
      id: parsed.id,
      customerId: parsed.customerId,
      status: parsed.status,
      priceId: parsed.priceId,
      quantity: parsed.quantity,
      currency: parsed.currency,
      currentPeriodEnd: parsed.currentPeriodEnd,
      trialEnd: parsed.trialEnd,
      cancelAtPeriodEnd: parsed.cancelAtPeriodEnd,
    });

    await this.auditRecord.recordWithinTransaction(tx, {
      tenantId,
      actor: { userId: null, platform: true },
      action: 'billing.subscription_synced',
      entityType: 'Subscription',
      entityId: updated.id,
      before: before ? { status: before.status, edition: before.edition, quantity: before.quantity } : null,
      after: { status: updated.status, edition: updated.edition, quantity: updated.quantity },
      metadata: { stripeEventId: event.id, stripeEventType: event.type },
    });

    if (updated.status === 'ACTIVE' || updated.status === 'TRIAL') {
      this.emit(BILLING_EVENTS.SUBSCRIPTION_ACTIVATED, tenantId, { edition: updated.edition });
    } else if (updated.status === 'PAST_DUE') {
      this.emit(BILLING_EVENTS.SUBSCRIPTION_PAST_DUE, tenantId, { edition: updated.edition });
    }
  }

  /**
   * A subscription reaching Stripe's own terminal `canceled` state is the
   * "non-payment eventually leads to suspension" tie-in this step's brief
   * calls for — the SAME `Tenant.status` enforcement 4.1 built
   * (`TenantScopeInterceptor` genuinely blocks every request, including
   * login, for a SUSPENDED tenant). Deliberately NOT triggered by
   * PAST_DUE alone: a tenant with a lapsed card should still be able to
   * log in and fix their payment method — only a subscription Stripe
   * itself has fully given up on (after its own configured dunning
   * retries) suspends the tenant. Dual-audited exactly like
   * `PlatformTenantService.suspend` (4.1) — the target tenant's own
   * `audit_log` (so its admin can see why, once they can log in again)
   * AND the platform's consolidated trail.
   */
  private async handleSubscriptionDeleted(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    const before = await tx.subscription.findUnique({ where: { tenantId } });
    const parsed = parseSubscriptionPayload(event.data.object);
    const updated = await this.billing.applySubscriptionFromStripe(tx, tenantId, before?.edition ?? 'STARTER', {
      id: parsed.id,
      customerId: parsed.customerId,
      status: 'canceled',
      priceId: parsed.priceId || (before?.stripePriceId ?? ''),
      quantity: parsed.quantity,
      currency: parsed.currency,
      currentPeriodEnd: parsed.currentPeriodEnd,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (tenant.status !== 'SUSPENDED') {
      // `hrm_app` (the role `tx` runs as inside withTenantContext) is
      // granted only SELECT on `tenants` — see docs/conventions/tenancy-rls.md
      // ("Tenant itself... is NOT subject to RLS" and is writable only
      // through the owner role). The SAME reason `PlatformTenantService.suspend`
      // (4.1) updates via the owner `prisma` client, not a tenant-scoped
      // `tx` — reused here verbatim.
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
      await this.auditRecord.recordWithinTransaction(tx, {
        tenantId,
        actor: { userId: null, platform: true },
        action: 'billing.tenant_suspended_for_nonpayment',
        entityType: 'Tenant',
        entityId: tenantId,
        before: { status: tenant.status },
        after: { status: 'SUSPENDED' },
        metadata: { stripeEventId: event.id, stripeSubscriptionId: updated.stripeSubscriptionId },
      });
      await this.platformAudit.record({
        platformAdminId: null,
        action: 'billing.tenant_suspended_for_nonpayment',
        entityType: 'Tenant',
        entityId: tenantId,
        targetTenantId: tenantId,
        before: { status: tenant.status },
        after: { status: 'SUSPENDED' },
        metadata: { stripeEventId: event.id },
      });
    }

    this.emit(BILLING_EVENTS.SUBSCRIPTION_CANCELED, tenantId, { edition: updated.edition });
  }

  private async handleInvoiceEvent(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    const parsed = parseInvoicePayload(event.data.object);
    const subscription = await tx.subscription.findUnique({ where: { tenantId } });

    const status = parsed.status.toUpperCase() as 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
    const invoice = await tx.invoice.upsert({
      where: { stripeInvoiceId: parsed.id },
      create: {
        tenantId,
        // OUR OWN Subscription row's id (not Stripe's) — Invoice.subscriptionId
        // is a local FK. This tenant has at most one Subscription (0.6's
        // `@@unique([tenantId])`), so it's always the right one for any
        // subscription-linked invoice event; an AMC invoice (no Subscription
        // involved at all) is created directly by PlatformBillingService,
        // never through this webhook path.
        subscriptionId: subscription?.id ?? null,
        type: 'SUBSCRIPTION',
        status,
        stripeInvoiceId: parsed.id,
        stripeCustomerId: parsed.customerId,
        currency: parsed.currency,
        amountDue: toDecimalFromMinorUnits(parsed.amountDueMinorUnits),
        amountPaid: toDecimalFromMinorUnits(parsed.amountPaidMinorUnits),
        amountRemaining: toDecimalFromMinorUnits(parsed.amountRemainingMinorUnits),
        description: parsed.description,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        dueDate: parsed.dueDate,
        hostedInvoiceUrl: parsed.hostedInvoiceUrl,
        invoicePdfUrl: parsed.invoicePdfUrl,
        issuedAt: new Date(),
        paidAt: status === 'PAID' ? new Date() : null,
        voidedAt: status === 'VOID' ? new Date() : null,
      },
      update: {
        status,
        amountDue: toDecimalFromMinorUnits(parsed.amountDueMinorUnits),
        amountPaid: toDecimalFromMinorUnits(parsed.amountPaidMinorUnits),
        amountRemaining: toDecimalFromMinorUnits(parsed.amountRemainingMinorUnits),
        hostedInvoiceUrl: parsed.hostedInvoiceUrl,
        invoicePdfUrl: parsed.invoicePdfUrl,
        paidAt: status === 'PAID' ? new Date() : undefined,
        voidedAt: status === 'VOID' ? new Date() : undefined,
      },
    });

    await this.auditRecord.recordWithinTransaction(tx, {
      tenantId,
      actor: { userId: null, platform: true },
      action: 'billing.invoice_synced',
      entityType: 'Invoice',
      entityId: invoice.id,
      after: { status: invoice.status, amountDue: invoice.amountDue.toString() },
      metadata: { stripeEventId: event.id, stripeEventType: event.type },
    });

    if (event.type === 'invoice.paid') {
      this.emit(BILLING_EVENTS.INVOICE_PAID, tenantId, { invoiceId: invoice.id });
    } else if (event.type === 'invoice.payment_failed') {
      this.emit(BILLING_EVENTS.INVOICE_PAYMENT_FAILED, tenantId, { invoiceId: invoice.id });
    }
  }

  private async handlePaymentMethodUpsert(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    const parsed = parsePaymentMethodPayload(event.data.object);
    await tx.paymentMethod.upsert({
      where: { stripePaymentMethodId: parsed.id },
      create: {
        tenantId,
        stripePaymentMethodId: parsed.id,
        type: parsed.type,
        brand: parsed.brand,
        last4: parsed.last4,
        expMonth: parsed.expMonth,
        expYear: parsed.expYear,
      },
      update: { brand: parsed.brand, last4: parsed.last4, expMonth: parsed.expMonth, expYear: parsed.expYear },
    });
  }

  private async handlePaymentMethodDetached(tx: Prisma.TransactionClient, tenantId: string, event: StripeEvent): Promise<void> {
    const parsed = parsePaymentMethodPayload(event.data.object);
    await tx.paymentMethod.deleteMany({ where: { tenantId, stripePaymentMethodId: parsed.id } });
  }

  private emit(type: (typeof BILLING_EVENTS)[keyof typeof BILLING_EVENTS], tenantId: string, extra: Record<string, unknown>): void {
    this.eventEmitter.emit(type, { type, tenantId, ...extra });
  }
}
