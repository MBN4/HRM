import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { isWebhookEventType, redactSensitiveFields, type WebhookDeliveryEnvelope } from '@hrm/shared';
import { WEBHOOK_DELIVERY_QUEUE } from '../../queue/queue.constants';

export interface DeliverWebhookJobData {
  tenantId: string;
  webhookDeliveryId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The webhook hub's PRODUCER side — the SAME two-phase shape 0.8's
 * `NotificationsService.handleDomainEvent` established: create the durable
 * DB rows in one transaction, THEN enqueue one BullMQ job per row AFTER
 * that transaction commits (never inside it — a job must never reference a
 * row from a transaction that could still roll back).
 *
 * Unlike notifications' recipient resolution, there is no analogous
 * "just-written, not-yet-committed" race to retry around here:
 * `WebhookSubscription` rows are pre-existing tenant CONFIGURATION, never
 * created by the same transaction the triggering domain event describes —
 * a subscription created moments ago is already committed and visible by
 * the time any later event fires. `payload` is REDACTED
 * (`redactSensitiveFields`, the SAME pass `AuditRecordService` runs every
 * audit entry through) before it is ever persisted onto `WebhookDelivery`
 * or signed — a second line of defense on top of `WEBHOOK_EVENT_TYPES`
 * already excluding the one genuinely dangerous event
 * (`auth.password_reset_requested`).
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);

  constructor(@InjectQueue(WEBHOOK_DELIVERY_QUEUE) private readonly queue: Queue<DeliverWebhookJobData>) {}

  async handleDomainEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (!isWebhookEventType(eventType)) {
      return;
    }
    const tenantId = payload.tenantId as string | undefined;
    if (!tenantId) {
      this.logger.warn(`Domain event "${eventType}" has no tenantId — cannot dispatch webhooks for it.`);
      return;
    }

    const envelope: WebhookDeliveryEnvelope = {
      id: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      tenantId,
      data: redactSensitiveFields(payload),
    };

    const deliveryIds = await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const subscriptions = await tx.webhookSubscription.findMany({
        where: { tenantId, status: 'ACTIVE', eventTypes: { has: eventType } },
      });
      const ids: string[] = [];
      for (const subscription of subscriptions) {
        const delivery = await tx.webhookDelivery.create({
          data: {
            tenantId,
            webhookSubscriptionId: subscription.id,
            eventType,
            payload: envelope as unknown as Prisma.InputJsonValue,
            status: 'PENDING',
          },
        });
        ids.push(delivery.id);
      }
      return ids;
    });

    for (const webhookDeliveryId of deliveryIds) {
      await this.queue.add('deliver', { tenantId, webhookDeliveryId }, JOB_OPTIONS);
    }
  }
}
