import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from './event-types';

/**
 * Webhook subscription DTOs — step 3.3. `url` is restricted to `http(s)`
 * only (never `file:`/`data:`/other schemes an SSRF-minded caller might try
 * to smuggle through a generic `z.string().url()`), the same "no
 * meaningless/dangerous combination silently accepted" posture this
 * codebase's other zod schemas already take.
 */
const httpsOrHttpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'url must be an http:// or https:// URL.',
});

export const createWebhookSubscriptionSchema = z.object({
  url: httpsOrHttpUrl,
  description: z.string().max(500).optional(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});
export type CreateWebhookSubscriptionInput = z.infer<typeof createWebhookSubscriptionSchema>;

export const WEBHOOK_SUBSCRIPTION_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export type WebhookSubscriptionStatusValue = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];

export const updateWebhookSubscriptionSchema = z
  .object({
    url: httpsOrHttpUrl.optional(),
    description: z.string().max(500).optional(),
    eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
    status: z.enum(WEBHOOK_SUBSCRIPTION_STATUSES).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: 'At least one field must be provided.' });
export type UpdateWebhookSubscriptionInput = z.infer<typeof updateWebhookSubscriptionSchema>;

/** The rendered outbound envelope every webhook delivery's body/signature covers — never re-derived differently between the signer and the delivery log. */
export interface WebhookDeliveryEnvelope {
  id: string;
  eventType: string;
  occurredAt: string;
  tenantId: string;
  data: unknown;
}
