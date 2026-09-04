/**
 * Structured domain events for every billing-worthy action (step 4.2),
 * emitted via `@nestjs/event-emitter` and consumed by
 * `NotificationDispatchListener`/`WebhookDispatchListener` (both gained a
 * `billing.*` subscription — see docs/conventions/billing.md). Unlike
 * `LICENSING_EVENTS`, this namespace is deliberately NOT also subscribed
 * by `DomainEventAuditListener` — `StripeWebhookService`/
 * `PlatformBillingService` write their OWN precise audit rows directly
 * (real before/after Subscription/Invoice snapshots plus the triggering
 * `stripeEventId`), the same explicit-audit posture `PlatformTenantService`
 * (4.1) established over `LicensingAdminService`'s older generic-event-only
 * one — see billing.md for the full reasoning.
 */
export const BILLING_EVENTS = {
  SUBSCRIPTION_ACTIVATED: 'billing.subscription_activated',
  SUBSCRIPTION_PAST_DUE: 'billing.subscription_past_due',
  SUBSCRIPTION_CANCELED: 'billing.subscription_canceled',
  INVOICE_PAID: 'billing.invoice_paid',
  INVOICE_PAYMENT_FAILED: 'billing.invoice_payment_failed',
  AMC_INVOICE_CREATED: 'billing.amc_invoice_created',
} as const;

export type BillingEventType = (typeof BILLING_EVENTS)[keyof typeof BILLING_EVENTS];

export interface BillingEventPayload {
  type: BillingEventType;
  tenantId: string;
  [key: string]: unknown;
}
