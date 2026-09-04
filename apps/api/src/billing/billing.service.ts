import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Invoice, PaymentMethod, Prisma, Subscription, SubscriptionStatus } from '@hrm/db';
import { BILLING_PLANS, TenantEditionKey } from '@hrm/shared';
import { SeatCapService } from '../licensing/seat-cap.service';
import { editionForPriceId, priceIdForEdition } from './billing-pricing.util';
import { BILLING_EVENTS } from './billing-events';
import { toDecimalFromMinorUnits } from './money.util';
import { computeProrationPreviewMinorUnits } from './proration.util';
import { STRIPE_CLIENT, StripeClient, StripeSubscription, StripeSubscriptionStatus } from './stripe/stripe-client.interface';

const TRIAL_PERIOD_DAYS = 14;
/** Matches MockStripeClient's own fixed period length — see that class's doc comment; used only to approximate a period START for the proration PREVIEW (never the authoritative charge). */
const APPROX_PERIOD_DAYS = 30;

export interface SubscriptionSummary {
  edition: TenantEditionKey;
  status: SubscriptionStatus;
  currency: string;
  quantity: number | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingSummary {
  subscription: SubscriptionSummary & { hasPaymentMethod: boolean };
  activeSeats: number;
  invoices: InvoiceSummary[];
  paymentMethods: PaymentMethodSummary[];
}

function toSubscriptionSummary(subscription: Subscription): SubscriptionSummary {
  return {
    edition: subscription.edition,
    status: subscription.status,
    currency: subscription.currency,
    quantity: subscription.quantity,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  };
}

export interface InvoiceSummary {
  id: string;
  type: string;
  status: string;
  currency: string;
  amountDue: string;
  amountPaid: string;
  amountRemaining: string;
  description: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface PaymentMethodSummary {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

function toInvoiceSummary(invoice: Invoice): InvoiceSummary {
  return {
    id: invoice.id,
    type: invoice.type,
    status: invoice.status,
    currency: invoice.currency,
    amountDue: invoice.amountDue.toString(),
    amountPaid: invoice.amountPaid.toString(),
    amountRemaining: invoice.amountRemaining.toString(),
    description: invoice.description,
    dueDate: invoice.dueDate?.toISOString() ?? null,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    invoicePdfUrl: invoice.invoicePdfUrl,
  };
}

function toPaymentMethodSummary(pm: PaymentMethod): PaymentMethodSummary {
  return { id: pm.id, brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear, isDefault: pm.isDefault };
}

/** Stripe's subscription-status vocabulary -> this schema's own `SubscriptionStatus` — see docs/conventions/billing.md. */
export function mapStripeSubscriptionStatus(status: StripeSubscriptionStatus): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'TRIAL';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
  }
}

/**
 * The tenant-facing core of SaaS billing (step 4.2) — see
 * docs/conventions/billing.md. Every mutating method here calls Stripe
 * through the `STRIPE_CLIENT` seam and then applies whatever Stripe
 * returned onto this tenant's OWN `Subscription`/`Invoice`/`PaymentMethod`
 * rows via `applySubscriptionFromStripe` — the SAME method
 * `StripeWebhookService` calls when the AUTHORITATIVE webhook for the same
 * change arrives later, so an optimistic apply here and the eventual
 * webhook-driven reconciliation can never disagree on HOW a Stripe object
 * maps onto this schema, only WHEN.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    private readonly config: ConfigService,
    private readonly seatCap: SeatCapService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Find-or-create — every tenant gets a `Subscription` row (TRIAL) the first time billing is touched at all, and a Stripe customer the first time Stripe itself needs to be involved. */
  async ensureCustomer(tx: Prisma.TransactionClient, tenantId: string): Promise<Subscription> {
    let subscription = await tx.subscription.findUnique({ where: { tenantId } });
    if (!subscription) {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      subscription = await tx.subscription.create({
        data: { tenantId, edition: tenant.edition, status: 'TRIAL', currency: 'usd' },
      });
    }
    if (subscription.stripeCustomerId) {
      return subscription;
    }

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const admin = await tx.userRole.findFirst({
      where: { role: { name: 'TENANT_ADMIN' }, user: { status: 'ACTIVE' } },
      include: { user: true },
    });
    const customer = await this.stripe.customers.create({ tenantId, name: tenant.name, email: admin?.user.email });
    return tx.subscription.update({ where: { tenantId }, data: { stripeCustomerId: customer.id } });
  }

  async getSummary(tx: Prisma.TransactionClient, tenantId: string): Promise<BillingSummary> {
    const subscription = await this.ensureCustomer(tx, tenantId);
    const [activeSeats, invoices, paymentMethods] = await Promise.all([
      this.seatCap.countActive(tx),
      tx.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      tx.paymentMethod.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
    ]);

    return {
      subscription: { ...toSubscriptionSummary(subscription), hasPaymentMethod: paymentMethods.length > 0 },
      activeSeats,
      invoices: invoices.map(toInvoiceSummary),
      paymentMethods: paymentMethods.map(toPaymentMethodSummary),
    };
  }

  /**
   * Upgrade/downgrade — bills for exactly the tenant's current active-seat
   * count (`SeatCapService.countActive`, THE one seat-counting definition
   * this codebase uses everywhere, see that service's doc comment).
   * Applies Stripe's response OPTIMISTICALLY (so the caller sees their new
   * plan immediately); the `customer.subscription.updated` webhook that
   * follows shortly after reconciles the same row again, idempotently — a
   * no-op in the common case where nothing changed in between.
   */
  async changePlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    edition: TenantEditionKey,
  ): Promise<{ subscription: SubscriptionSummary; prorationPreviewMinorUnits: string }> {
    const before = await this.ensureCustomer(tx, tenantId);
    const quantity = await this.seatCap.countActive(tx);
    const priceId = priceIdForEdition(edition, (key) => this.config.get<string>(key));

    const preview = this.previewProration(before, edition, quantity);

    const isFirstSubscription = !before.stripeSubscriptionId;
    const stripeSub = before.stripeSubscriptionId
      ? await this.stripe.subscriptions.update(before.stripeSubscriptionId, { priceId, quantity, prorationBehavior: 'create_prorations' })
      : await this.stripe.subscriptions.create({
          tenantId,
          customerId: before.stripeCustomerId!,
          priceId,
          quantity,
          trialPeriodDays: before.status === 'TRIAL' ? TRIAL_PERIOD_DAYS : undefined,
        });

    if (isFirstSubscription) {
      await this.chargeSetupFeeIfApplicable(tx, tenantId, edition, before.stripeCustomerId!);
    }

    const updated = await this.applySubscriptionFromStripe(tx, tenantId, edition, stripeSub);
    if (before.status !== 'ACTIVE' && before.status !== 'TRIAL' && (updated.status === 'ACTIVE' || updated.status === 'TRIAL')) {
      this.emit(BILLING_EVENTS.SUBSCRIPTION_ACTIVATED, tenantId, { edition });
    }

    return {
      subscription: toSubscriptionSummary(updated),
      prorationPreviewMinorUnits: (stripeSub.latestProrationAmountMinorUnits ?? preview.toNumber()).toString(),
    };
  }

  async cancelSubscription(tx: Prisma.TransactionClient, tenantId: string, atPeriodEnd: boolean): Promise<Subscription> {
    const subscription = await this.ensureCustomer(tx, tenantId);
    if (!subscription.stripeSubscriptionId) {
      throw new BadRequestException('This tenant has no active Stripe subscription to cancel.');
    }
    const stripeSub = await this.stripe.subscriptions.cancel(subscription.stripeSubscriptionId, { atPeriodEnd });
    return this.applySubscriptionFromStripe(tx, tenantId, subscription.edition, stripeSub);
  }

  async createSetupIntent(tx: Prisma.TransactionClient, tenantId: string): Promise<{ clientSecret: string }> {
    const subscription = await this.ensureCustomer(tx, tenantId);
    const intent = await this.stripe.setupIntents.create({ customerId: subscription.stripeCustomerId! });
    return { clientSecret: intent.clientSecret };
  }

  async attachPaymentMethod(
    tx: Prisma.TransactionClient,
    tenantId: string,
    paymentMethodId: string,
    setAsDefault: boolean,
  ): Promise<PaymentMethodSummary> {
    const subscription = await this.ensureCustomer(tx, tenantId);
    const pm = await this.stripe.paymentMethods.attach(paymentMethodId, { customerId: subscription.stripeCustomerId!, setAsDefault });
    if (setAsDefault) {
      await tx.paymentMethod.updateMany({ where: { tenantId }, data: { isDefault: false } });
    }
    const row = await tx.paymentMethod.upsert({
      where: { stripePaymentMethodId: pm.id },
      create: {
        tenantId,
        stripePaymentMethodId: pm.id,
        type: pm.type,
        brand: pm.brand,
        last4: pm.last4,
        expMonth: pm.expMonth,
        expYear: pm.expYear,
        isDefault: pm.isDefault,
      },
      update: { brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear, isDefault: pm.isDefault },
    });
    return toPaymentMethodSummary(row);
  }

  async removePaymentMethod(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<void> {
    const row = await tx.paymentMethod.findFirst({ where: { id, tenantId } });
    if (!row) {
      return;
    }
    await this.stripe.paymentMethods.detach(row.stripePaymentMethodId);
    await tx.paymentMethod.delete({ where: { id } });
  }

  /**
   * A one-time, invoice-only charge (no Subscription line item — matches
   * how a real setup/implementation fee is typically billed) fired ONLY
   * the first time a tenant ever gets a real Stripe subscription. Uses
   * `@hrm/shared`'s `BILLING_PLANS` reference figures — see that file's
   * own doc comment on why a real deployment's actual number lives in
   * Stripe's own Price/Product config, not here; this is a best-effort
   * side charge — deliberately best-effort ONLY around the Stripe API
   * call itself (caught, logged, the subscription change proceeds
   * regardless): a failure there means nothing has been written to
   * Postgres yet, so there's nothing to roll back. The subsequent
   * `tx.invoice.create` is NOT wrapped the same way and is allowed to
   * propagate — inside a Postgres transaction, a failed statement aborts
   * every later statement in that same transaction regardless of whether
   * the JS exception around it is caught, so swallowing a write failure
   * here would be false safety, not real resilience.
   */
  private async chargeSetupFeeIfApplicable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    edition: TenantEditionKey,
    stripeCustomerId: string,
  ): Promise<void> {
    const setupFeeMinorUnits = BILLING_PLANS[edition].setupFeeMinorUnits;
    if (setupFeeMinorUnits <= 0) {
      return;
    }
    let stripeInvoice;
    try {
      stripeInvoice = await this.stripe.invoices.create({
        customerId: stripeCustomerId,
        currency: BILLING_PLANS[edition].currency,
        amountMinorUnits: setupFeeMinorUnits,
        description: `${edition} plan setup/implementation fee`,
      });
    } catch (error) {
      this.logger.error(`Failed to charge the ${edition} setup fee for tenant "${tenantId}": ${String(error)}`);
      return;
    }
    await tx.invoice.create({
      data: {
        tenantId,
        subscriptionId: null,
        type: 'SETUP_FEE',
        status: stripeInvoice.status.toUpperCase() as 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE',
        stripeInvoiceId: stripeInvoice.id,
        stripeCustomerId,
        currency: stripeInvoice.currency,
        amountDue: toDecimalFromMinorUnits(stripeInvoice.amountDueMinorUnits),
        amountPaid: toDecimalFromMinorUnits(stripeInvoice.amountPaidMinorUnits),
        amountRemaining: toDecimalFromMinorUnits(stripeInvoice.amountRemainingMinorUnits),
        description: stripeInvoice.description,
        dueDate: stripeInvoice.dueDate,
        hostedInvoiceUrl: stripeInvoice.hostedInvoiceUrl,
        invoicePdfUrl: stripeInvoice.invoicePdfUrl,
        issuedAt: new Date(),
      },
    });
  }

  /**
   * Applies a Stripe `Subscription` object onto this tenant's row — the
   * ONE mapping function both the optimistic (`changePlan`) and
   * authoritative (`StripeWebhookService`) paths call, so they can never
   * disagree on how a Stripe status maps to `SubscriptionStatus` or which
   * fields get written. `edition` is resolved from the subscription's OWN
   * price id when recognized (see `editionForPriceId`), falling back to
   * the CALLER-SUPPLIED edition otherwise (an unrecognized price id never
   * silently changes a tenant's edition — see billing.md).
   */
  async applySubscriptionFromStripe(
    tx: Prisma.TransactionClient,
    tenantId: string,
    fallbackEdition: TenantEditionKey,
    stripeSub: StripeSubscription,
  ): Promise<Subscription> {
    const resolvedEdition = editionForPriceId(stripeSub.priceId, (key) => this.config.get<string>(key)) ?? fallbackEdition;
    return tx.subscription.update({
      where: { tenantId },
      data: {
        edition: resolvedEdition,
        status: mapStripeSubscriptionStatus(stripeSub.status),
        stripeSubscriptionId: stripeSub.id,
        stripePriceId: stripeSub.priceId,
        quantity: stripeSub.quantity,
        currency: stripeSub.currency,
        currentPeriodEnd: stripeSub.currentPeriodEnd,
        trialEndsAt: stripeSub.trialEnd,
        cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd,
      },
    });
  }

  /** minor-units PREVIEW only — see proration.util.ts's own doc comment for why this is never the authoritative charge. */
  private previewProration(subscription: Subscription, newEdition: TenantEditionKey, newQuantity: number): Prisma.Decimal {
    const periodEnd = subscription.currentPeriodEnd ?? new Date();
    const periodStart = new Date(periodEnd.getTime() - APPROX_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    return computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: BILLING_PLANS[subscription.edition].seatMonthlyMinorUnits,
      oldQuantity: subscription.quantity ?? newQuantity,
      newSeatMonthlyMinorUnits: BILLING_PLANS[newEdition].seatMonthlyMinorUnits,
      newQuantity,
      periodStart,
      periodEnd,
    });
  }

  private emit(type: (typeof BILLING_EVENTS)[keyof typeof BILLING_EVENTS], tenantId: string, extra: Record<string, unknown>): void {
    this.eventEmitter.emit(type, { type, tenantId, ...extra });
  }
}
