import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type {
  StripeClient,
  StripeCreateInvoiceParams,
  StripeCreateSubscriptionParams,
  StripeCustomer,
  StripeEvent,
  StripeInvoice,
  StripeInvoiceStatus,
  StripePaymentMethod,
  StripeSubscription,
  StripeSubscriptionStatus,
  StripeUpdateSubscriptionParams,
} from './stripe-client.interface';

/**
 * The REAL binding — thin adapter over the official `stripe` npm package
 * (bound whenever `STRIPE_SECRET_KEY` is set; works against Stripe TEST or
 * LIVE mode transparently, since that's purely which key it's given — see
 * `stripe.module.ts` and docs/conventions/billing.md). Every method here
 * does exactly two things: call the real SDK, then map its (much larger)
 * response object down to this codebase's own minimal `StripeClient`
 * shapes — no business logic lives here, matching every other adapter in
 * this codebase (`GenericCsvBankExportAdapter`, `NoopAccountingAdapter`).
 */
@Injectable()
export class RealStripeClient implements StripeClient {
  private readonly stripe: Stripe;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      throw new Error('RealStripeClient requires STRIPE_SECRET_KEY — this should never be constructed without it, see stripe.module.ts.');
    }
    // No explicit `apiVersion` pin — uses this `stripe` package version's
    // own default pinned API version, so a `stripe` dependency bump is the
    // only place that needs to change, not this call site too.
    this.stripe = new Stripe(secretKey);
  }

  customers = {
    create: async (params: { tenantId: string; email?: string; name?: string }): Promise<StripeCustomer> => {
      const customer = await this.stripe.customers.create({
        email: params.email,
        name: params.name,
        metadata: { tenantId: params.tenantId },
      });
      return this.toCustomer(customer);
    },
    retrieve: async (customerId: string): Promise<StripeCustomer | null> => {
      const customer = await this.stripe.customers.retrieve(customerId);
      if (customer.deleted) {
        return null;
      }
      return this.toCustomer(customer);
    },
  };

  subscriptions = {
    create: async (params: StripeCreateSubscriptionParams): Promise<StripeSubscription> => {
      const subscription = await this.stripe.subscriptions.create({
        customer: params.customerId,
        items: [{ price: params.priceId, quantity: params.quantity }],
        trial_period_days: params.trialPeriodDays,
        metadata: { tenantId: params.tenantId },
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice'],
      });
      return this.toSubscription(subscription);
    },
    update: async (subscriptionId: string, params: StripeUpdateSubscriptionParams): Promise<StripeSubscription> => {
      const current = await this.stripe.subscriptions.retrieve(subscriptionId);
      const itemId = current.items.data[0].id;
      const subscription = await this.stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: params.priceId, quantity: params.quantity }],
        proration_behavior: params.prorationBehavior ?? 'create_prorations',
      });
      return this.toSubscription(subscription);
    },
    cancel: async (subscriptionId: string, params?: { atPeriodEnd?: boolean }): Promise<StripeSubscription> => {
      const subscription = params?.atPeriodEnd
        ? await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
        : await this.stripe.subscriptions.cancel(subscriptionId);
      return this.toSubscription(subscription);
    },
    retrieve: async (subscriptionId: string): Promise<StripeSubscription | null> => {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
        return this.toSubscription(subscription);
      } catch {
        return null;
      }
    },
  };

  invoices = {
    create: async (params: StripeCreateInvoiceParams): Promise<StripeInvoice> => {
      const invoice = await this.stripe.invoices.create({
        customer: params.customerId,
        currency: params.currency,
        collection_method: 'send_invoice',
        days_until_due: params.dueDate ? undefined : 30,
        due_date: params.dueDate ? Math.floor(params.dueDate.getTime() / 1000) : undefined,
      });
      await this.stripe.invoiceItems.create({
        customer: params.customerId,
        invoice: invoice.id,
        amount: params.amountMinorUnits,
        currency: params.currency,
        description: params.description,
      });
      const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id);
      return this.toInvoice(finalized);
    },
    retrieve: async (invoiceId: string): Promise<StripeInvoice | null> => {
      try {
        const invoice = await this.stripe.invoices.retrieve(invoiceId);
        return this.toInvoice(invoice);
      } catch {
        return null;
      }
    },
    list: async (params: { customerId: string; limit?: number }): Promise<StripeInvoice[]> => {
      const invoices = await this.stripe.invoices.list({ customer: params.customerId, limit: params.limit ?? 25 });
      return invoices.data.map((invoice) => this.toInvoice(invoice));
    },
  };

  paymentMethods = {
    list: async (customerId: string): Promise<StripePaymentMethod[]> => {
      const [methods, customer] = await Promise.all([
        this.stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
        this.stripe.customers.retrieve(customerId),
      ]);
      const defaultId =
        !customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : null;
      return methods.data.map((pm) => this.toPaymentMethod(pm, pm.id === defaultId));
    },
    attach: async (paymentMethodId: string, params: { customerId: string; setAsDefault?: boolean }): Promise<StripePaymentMethod> => {
      const pm = await this.stripe.paymentMethods.attach(paymentMethodId, { customer: params.customerId });
      if (params.setAsDefault) {
        await this.stripe.customers.update(params.customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
      }
      return this.toPaymentMethod(pm, Boolean(params.setAsDefault));
    },
    detach: async (paymentMethodId: string): Promise<void> => {
      await this.stripe.paymentMethods.detach(paymentMethodId);
    },
  };

  setupIntents = {
    create: async (params: { customerId: string }): Promise<{ id: string; clientSecret: string }> => {
      const intent = await this.stripe.setupIntents.create({ customer: params.customerId });
      return { id: intent.id, clientSecret: intent.client_secret! };
    },
  };

  webhooks = {
    constructEvent: (rawBody: string | Buffer, signatureHeader: string, endpointSecret: string): StripeEvent => {
      const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret);
      return { id: event.id, type: event.type, data: { object: event.data.object as unknown as Record<string, unknown> } };
    },
  };

  private toCustomer(customer: Stripe.Customer): StripeCustomer {
    return { id: customer.id, email: customer.email ?? null, name: customer.name ?? null };
  }

  private toSubscription(subscription: Stripe.Subscription): StripeSubscription {
    const item = subscription.items.data[0];
    return {
      id: subscription.id,
      customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
      status: subscription.status as StripeSubscriptionStatus,
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
      currency: subscription.currency,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }

  private toInvoice(invoice: Stripe.Invoice): StripeInvoice {
    return {
      id: invoice.id,
      customerId: typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? ''),
      subscriptionId: typeof invoice.subscription === 'string' ? invoice.subscription : (invoice.subscription?.id ?? null),
      status: (invoice.status ?? 'draft') as StripeInvoiceStatus,
      currency: invoice.currency,
      amountDueMinorUnits: invoice.amount_due,
      amountPaidMinorUnits: invoice.amount_paid,
      amountRemainingMinorUnits: invoice.amount_remaining,
      description: invoice.description,
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
      dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdfUrl: invoice.invoice_pdf ?? null,
      paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null,
      voidedAt: invoice.status_transitions?.voided_at ? new Date(invoice.status_transitions.voided_at * 1000) : null,
    };
  }

  private toPaymentMethod(pm: Stripe.PaymentMethod, isDefault: boolean): StripePaymentMethod {
    return {
      id: pm.id,
      customerId: typeof pm.customer === 'string' ? pm.customer : (pm.customer?.id ?? ''),
      type: pm.type,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
      isDefault,
    };
  }
}
