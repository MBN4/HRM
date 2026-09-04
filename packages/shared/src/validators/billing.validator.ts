import { z } from 'zod';
import { TENANT_EDITIONS } from '../constants/feature-flags';

/**
 * Billing request DTOs — step 4.2. See docs/conventions/billing.md. Same
 * "JSON has no schema-level guarantee of its own" posture every other
 * mutation in this codebase takes: `ZodValidationPipe` validates every one
 * of these at the route.
 */

export const changePlanRequestSchema = z.object({
  edition: z.enum(TENANT_EDITIONS),
});
export type ChangePlanInput = z.infer<typeof changePlanRequestSchema>;

/**
 * `paymentMethodId` is a Stripe PaymentMethod id (`pm_...`) produced
 * CLIENT-SIDE by Stripe.js/Elements after collecting card details directly
 * with Stripe — the raw PAN never reaches this backend, so there is
 * nothing here for `EncryptionService` to protect (see billing.md's
 * security section).
 */
export const attachPaymentMethodRequestSchema = z.object({
  paymentMethodId: z.string().min(1),
  setAsDefault: z.boolean().optional(),
});
export type AttachPaymentMethodInput = z.infer<typeof attachPaymentMethodRequestSchema>;

export const cancelSubscriptionRequestSchema = z.object({
  /** Default true — cancel at the end of the current paid period rather than immediately. */
  atPeriodEnd: z.boolean().optional().default(true),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionRequestSchema>;

/** Platform-triggered — see PlatformBillingService.createAmcInvoice. Invoice-only, no Stripe Subscription involved. */
export const createAmcInvoiceRequestSchema = z.object({
  amountMinorUnits: z.number().int().positive(),
  currency: z.string().length(3).toLowerCase(),
  description: z.string().min(1),
  dueInDays: z.number().int().positive().max(365).optional(),
});
export type CreateAmcInvoiceInput = z.infer<typeof createAmcInvoiceRequestSchema>;
