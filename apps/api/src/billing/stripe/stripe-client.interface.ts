export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * The Stripe integration seam (step 4.2) — the SAME Symbol-token +
 * interface + `{provide, useClass}` shape as `AUTH_PROVIDER`/
 * `PAYROLL_PROVIDER_ADAPTER`/`ACCOUNTING_ADAPTER`. This interface names
 * ONLY the operations `BillingService`/`StripeWebhookService`/
 * `PlatformBillingService` actually call — not a wrapper around the whole
 * Stripe SDK — the same "adapter surface is exactly what this codebase
 * needs, not a vendor-SDK mirror" posture `AccountingAdapter`/
 * `BankExportAdapter` already take. Two bindings (see `stripe.module.ts`):
 * `RealStripeClient` (wraps the real `stripe` npm package — works against
 * Stripe TEST or LIVE mode, whichever key it's given) and
 * `MockStripeClient` (in-memory, deterministic — the default whenever
 * `STRIPE_SECRET_KEY` is unset, so the full suite runs with no live Stripe
 * account, per this step's own brief).
 *
 * All monetary amounts here are Stripe's own convention: INTEGER MINOR
 * UNITS (e.g. cents for USD) — callers convert to/from `Prisma.Decimal`
 * at the boundary (`new Prisma.Decimal(minorUnits).dividedBy(100)`),
 * NEVER via JS float division. See docs/conventions/billing.md.
 */
export interface StripeClient {
  customers: {
    create(params: { tenantId: string; email?: string; name?: string }): Promise<StripeCustomer>;
    retrieve(customerId: string): Promise<StripeCustomer | null>;
  };
  subscriptions: {
    create(params: StripeCreateSubscriptionParams): Promise<StripeSubscription>;
    update(subscriptionId: string, params: StripeUpdateSubscriptionParams): Promise<StripeSubscription>;
    cancel(subscriptionId: string, params?: { atPeriodEnd?: boolean }): Promise<StripeSubscription>;
    retrieve(subscriptionId: string): Promise<StripeSubscription | null>;
  };
  invoices: {
    /** `subscriptionId` omitted => a one-off (AMC/setup-fee) invoice, not tied to any Subscription. */
    create(params: StripeCreateInvoiceParams): Promise<StripeInvoice>;
    retrieve(invoiceId: string): Promise<StripeInvoice | null>;
    list(params: { customerId: string; limit?: number }): Promise<StripeInvoice[]>;
  };
  paymentMethods: {
    list(customerId: string): Promise<StripePaymentMethod[]>;
    attach(paymentMethodId: string, params: { customerId: string; setAsDefault?: boolean }): Promise<StripePaymentMethod>;
    detach(paymentMethodId: string): Promise<void>;
  };
  setupIntents: {
    create(params: { customerId: string }): Promise<{ id: string; clientSecret: string }>;
  };
  webhooks: {
    /** Throws on a missing/invalid/stale signature — see StripeWebhookService. */
    constructEvent(rawBody: string | Buffer, signatureHeader: string, endpointSecret: string): StripeEvent;
  };
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
}

export type StripeSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid';

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: StripeSubscriptionStatus;
  priceId: string;
  quantity: number;
  currency: string;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Present only when this update produced an immediate proration invoice item — see BillingService.changePlan. */
  latestProrationAmountMinorUnits?: number;
}

export interface StripeCreateSubscriptionParams {
  tenantId: string;
  customerId: string;
  priceId: string;
  quantity: number;
  trialPeriodDays?: number;
}

export interface StripeUpdateSubscriptionParams {
  priceId?: string;
  quantity?: number;
  /** 'create_prorations' (default, interactive plan/seat changes) vs. 'none' (the automated daily seat-metering sync — see billing.md). */
  prorationBehavior?: 'create_prorations' | 'none';
}

export type StripeInvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface StripeInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  status: StripeInvoiceStatus;
  currency: string;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  amountRemainingMinorUnits: number;
  description: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  dueDate: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  paidAt: Date | null;
  voidedAt: Date | null;
}

export interface StripeCreateInvoiceParams {
  customerId: string;
  currency: string;
  amountMinorUnits: number;
  description: string;
  dueDate?: Date;
}

export interface StripePaymentMethod {
  id: string;
  customerId: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}
