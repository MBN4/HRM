import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { verifyWebhookSignature } from '../../integrations/webhooks/webhook-signature.util';
import type {
  StripeClient,
  StripeCreateInvoiceParams,
  StripeCreateSubscriptionParams,
  StripeCustomer,
  StripeEvent,
  StripeInvoice,
  StripePaymentMethod,
  StripeSubscription,
  StripeUpdateSubscriptionParams,
} from './stripe-client.interface';
import { mockUnitAmountForPriceId } from '../billing-pricing.util';

const PERIOD_DAYS = 30;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The default `STRIPE_CLIENT` binding whenever `STRIPE_SECRET_KEY` is
 * unset (local dev, and this codebase's full e2e suite — see
 * docs/conventions/billing.md and `stripe.module.ts`). An in-memory,
 * deterministic, single-process fake of just enough of Stripe's object
 * model for `BillingService`/`PlatformBillingService` to exercise their
 * real logic end to end with NO live Stripe account and NO network call —
 * the same "stub, tagged, no real math/I/O against a real dependency"
 * posture `StubPayrollProviderAdapter`/`NoopAccountingAdapter` already
 * establish for their own categories.
 *
 * Deliberately does NOT fire webhook events itself — in this codebase's
 * test suite, a "Stripe told us something changed" scenario is simulated
 * by constructing a signed fake `StripeEvent` payload directly (the SAME
 * `t=<ts>,v1=<hmac>` header scheme this mock's own `webhooks.constructEvent`
 * verifies, reusing 3.3's EXISTING outbound-webhook `verifyWebhookSignature`
 * util (`integrations/webhooks/webhook-signature.util.ts`) — and POSTing it to
 * `POST /billing/webhooks/stripe`, exactly like a real Stripe delivery
 * would. That keeps "the API call side" (this class) and "the async
 * webhook side" (StripeWebhookService) independently testable, matching
 * how they're genuinely decoupled in production too.
 *
 * Proration here is a SIMPLIFIED, own-computed simulation (a flat 30-day
 * period, `(newMrr - oldMrr) * daysRemaining/30`) — real Stripe's
 * proration engine is more precise (exact calendar days, multiple line
 * items, tax). This mock exists to prove `BillingService`'s OWN handling
 * of whatever Stripe returns is Decimal-safe and idempotent, not to
 * reimplement Stripe's billing engine — see billing.md's "known gaps".
 */
@Injectable()
export class MockStripeClient implements StripeClient {
  private readonly customerStore = new Map<string, StripeCustomer>();
  private readonly subscriptionStore = new Map<string, StripeSubscription>();
  private readonly invoiceStore = new Map<string, StripeInvoice>();
  private readonly paymentMethodStore = new Map<string, StripePaymentMethod>();

  customers = {
    create: async (params: { tenantId: string; email?: string; name?: string }): Promise<StripeCustomer> => {
      const customer: StripeCustomer = { id: `cus_mock_${randomUUID()}`, email: params.email ?? null, name: params.name ?? null };
      this.customerStore.set(customer.id, customer);
      return customer;
    },
    retrieve: async (customerId: string): Promise<StripeCustomer | null> => this.customerStore.get(customerId) ?? null,
  };

  subscriptions = {
    create: async (params: StripeCreateSubscriptionParams): Promise<StripeSubscription> => {
      const now = new Date();
      const trialing = Boolean(params.trialPeriodDays && params.trialPeriodDays > 0);
      const subscription: StripeSubscription = {
        id: `sub_mock_${randomUUID()}`,
        customerId: params.customerId,
        status: trialing ? 'trialing' : 'active',
        priceId: params.priceId,
        quantity: params.quantity,
        currency: 'usd',
        currentPeriodEnd: addDays(now, trialing ? (params.trialPeriodDays as number) : PERIOD_DAYS),
        trialEnd: trialing ? addDays(now, params.trialPeriodDays as number) : null,
        cancelAtPeriodEnd: false,
      };
      this.subscriptionStore.set(subscription.id, subscription);
      return subscription;
    },
    update: async (subscriptionId: string, params: StripeUpdateSubscriptionParams): Promise<StripeSubscription> => {
      const existing = this.requireSubscription(subscriptionId);
      const oldUnitAmount = mockUnitAmountForPriceId(existing.priceId);
      const newPriceId = params.priceId ?? existing.priceId;
      const newQuantity = params.quantity ?? existing.quantity;
      const newUnitAmount = mockUnitAmountForPriceId(newPriceId);

      let latestProrationAmountMinorUnits: number | undefined;
      const prorate = (params.prorationBehavior ?? 'create_prorations') === 'create_prorations';
      const changed = newPriceId !== existing.priceId || newQuantity !== existing.quantity;
      if (prorate && changed) {
        const now = new Date();
        const msRemaining = Math.max(0, existing.currentPeriodEnd.getTime() - now.getTime());
        const daysRemaining = msRemaining / (24 * 60 * 60 * 1000);
        const fraction = Math.min(1, daysRemaining / PERIOD_DAYS);
        const oldMrr = oldUnitAmount * existing.quantity;
        const newMrr = newUnitAmount * newQuantity;
        latestProrationAmountMinorUnits = Math.round((newMrr - oldMrr) * fraction);
      }

      const updated: StripeSubscription = {
        ...existing,
        priceId: newPriceId,
        quantity: newQuantity,
        latestProrationAmountMinorUnits,
      };
      this.subscriptionStore.set(subscriptionId, updated);
      return updated;
    },
    cancel: async (subscriptionId: string, params?: { atPeriodEnd?: boolean }): Promise<StripeSubscription> => {
      const existing = this.requireSubscription(subscriptionId);
      const updated: StripeSubscription = params?.atPeriodEnd
        ? { ...existing, cancelAtPeriodEnd: true }
        : { ...existing, status: 'canceled', cancelAtPeriodEnd: false };
      this.subscriptionStore.set(subscriptionId, updated);
      return updated;
    },
    retrieve: async (subscriptionId: string): Promise<StripeSubscription | null> => this.subscriptionStore.get(subscriptionId) ?? null,
  };

  invoices = {
    create: async (params: StripeCreateInvoiceParams): Promise<StripeInvoice> => {
      const invoice: StripeInvoice = {
        id: `in_mock_${randomUUID()}`,
        customerId: params.customerId,
        subscriptionId: null,
        status: 'open',
        currency: params.currency,
        amountDueMinorUnits: params.amountMinorUnits,
        amountPaidMinorUnits: 0,
        amountRemainingMinorUnits: params.amountMinorUnits,
        description: params.description,
        periodStart: null,
        periodEnd: null,
        dueDate: params.dueDate ?? null,
        hostedInvoiceUrl: `https://mock.stripe.local/invoices/${randomUUID()}`,
        invoicePdfUrl: `https://mock.stripe.local/invoices/${randomUUID()}/pdf`,
        paidAt: null,
        voidedAt: null,
      };
      this.invoiceStore.set(invoice.id, invoice);
      return invoice;
    },
    retrieve: async (invoiceId: string): Promise<StripeInvoice | null> => this.invoiceStore.get(invoiceId) ?? null,
    list: async (params: { customerId: string; limit?: number }): Promise<StripeInvoice[]> =>
      [...this.invoiceStore.values()].filter((invoice) => invoice.customerId === params.customerId).slice(0, params.limit ?? 25),
  };

  paymentMethods = {
    list: async (customerId: string): Promise<StripePaymentMethod[]> =>
      [...this.paymentMethodStore.values()].filter((pm) => pm.customerId === customerId),
    attach: async (paymentMethodId: string, params: { customerId: string; setAsDefault?: boolean }): Promise<StripePaymentMethod> => {
      if (params.setAsDefault) {
        for (const [id, pm] of this.paymentMethodStore) {
          if (pm.customerId === params.customerId) {
            this.paymentMethodStore.set(id, { ...pm, isDefault: false });
          }
        }
      }
      const paymentMethod: StripePaymentMethod = {
        id: paymentMethodId,
        customerId: params.customerId,
        type: 'card',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: new Date().getFullYear() + 2,
        isDefault: params.setAsDefault ?? this.paymentMethodStore.size === 0,
      };
      this.paymentMethodStore.set(paymentMethodId, paymentMethod);
      return paymentMethod;
    },
    detach: async (paymentMethodId: string): Promise<void> => {
      this.paymentMethodStore.delete(paymentMethodId);
    },
  };

  setupIntents = {
    create: async (params: { customerId: string }): Promise<{ id: string; clientSecret: string }> => {
      const id = `seti_mock_${randomUUID()}`;
      return { id, clientSecret: `${id}_secret_${params.customerId}` };
    },
  };

  webhooks = {
    constructEvent: (rawBody: string | Buffer, signatureHeader: string, endpointSecret: string): StripeEvent => {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      if (!verifyWebhookSignature(endpointSecret, signatureHeader, body)) {
        throw new Error('Invalid Stripe webhook signature.');
      }
      return JSON.parse(body) as StripeEvent;
    },
  };

  private requireSubscription(subscriptionId: string): StripeSubscription {
    const subscription = this.subscriptionStore.get(subscriptionId);
    if (!subscription) {
      throw new Error(`[MockStripeClient] No such subscription: "${subscriptionId}".`);
    }
    return subscription;
  }
}
