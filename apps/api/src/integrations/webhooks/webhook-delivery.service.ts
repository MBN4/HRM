import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { CircuitBreakerService } from '../../resilience/circuit-breaker/circuit-breaker.service';
import { buildWebhookHeaders } from './webhook-signature.util';

const RESPONSE_BODY_CAPTURE_LIMIT = 2000;

/**
 * The webhook hub's CONSUMER side — the SAME retry/dead-letter shape 0.8's
 * `NotificationDeliveryService.deliver` established (see its own doc
 * comment for the full reasoning): separate `withTenantContext`
 * transactions for the read, the send, and the final status write (so a
 * "record FAILED and re-throw for BullMQ to retry" never rolls its own
 * write back), always records `attempts`/response details, dead-letters on
 * the job's FINAL BullMQ attempt without re-throwing.
 *
 * `CircuitBreakerService.execute('webhook:<subscriptionId>', ...)` — ONE
 * breaker PER SUBSCRIPTION (not per-tenant, not global): a single broken
 * receiver endpoint trips only ITS OWN breaker, exactly like notifications'
 * one-breaker-per-channel isolation, so one tenant's misconfigured
 * endpoint can never affect delivery to any other subscription anywhere in
 * the system. A `CircuitOpenError` flows into the SAME failure-recording
 * path as any other send failure — no special-casing needed.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly encryption: EncryptionService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  async deliver(tenantId: string, webhookDeliveryId: string, attemptsMade: number, maxAttempts: number): Promise<void> {
    const delivery = await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
      tx.webhookDelivery.findUnique({ where: { id: webhookDeliveryId }, include: { subscription: true } }),
    );
    if (!delivery || delivery.status === 'SUCCEEDED' || delivery.status === 'DEAD_LETTER') {
      return;
    }
    // A subscription paused/deleted after this delivery was enqueued —
    // nothing to send to; leave the row PENDING rather than failing it,
    // consistent with this codebase's "don't punish a delivery for a
    // config change that happened after it was queued" posture.
    if (delivery.subscription.status !== 'ACTIVE') {
      return;
    }

    const rawBody = JSON.stringify(delivery.payload);
    const secret = this.encryption.decrypt(delivery.subscription.signingSecretEncrypted);

    try {
      const response = await this.circuitBreaker.execute(`webhook:${delivery.webhookSubscriptionId}`, () =>
        this.post(delivery.subscription.url, rawBody, secret),
      );
      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'SUCCEEDED',
            attempts: { increment: 1 },
            lastResponseStatus: response.status,
            lastResponseBody: response.body,
            deliveredAt: new Date(),
          },
        }),
      );
    } catch (error) {
      const isFinalAttempt = attemptsMade + 1 >= maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: { attempts: { increment: 1 }, lastError: message, status: isFinalAttempt ? 'DEAD_LETTER' : 'FAILED' },
        }),
      );
      if (!isFinalAttempt) {
        throw error;
      }
      this.logger.warn(`Webhook delivery "${delivery.id}" dead-lettered after ${maxAttempts} attempts: ${message}`);
    }
  }

  private async post(url: string, rawBody: string, secret: string): Promise<{ status: number; body: string }> {
    const response = await fetch(url, { method: 'POST', headers: buildWebhookHeaders(secret, rawBody), body: rawBody });
    const body = (await response.text().catch(() => '')).slice(0, RESPONSE_BODY_CAPTURE_LIMIT);
    if (!response.ok) {
      throw new Error(`Receiver responded HTTP ${response.status}: ${body}`);
    }
    return { status: response.status, body };
  }
}
