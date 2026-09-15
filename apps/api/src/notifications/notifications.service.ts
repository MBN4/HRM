import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { isNotificationEventType } from '@hrm/shared';
import { NOTIFICATIONS_QUEUE } from '../queue/queue.constants';
import { injectTraceContext, TraceCarrier } from '../tracing/queue-trace.util';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientResolverService } from './notification-recipient-resolver.service';

export interface DeliverNotificationJobData {
  tenantId: string;
  notificationDeliveryId: string;
  /** Phase 5.4 — carries the enqueuing request's trace context across the process boundary; see tracing/queue-trace.util.ts. */
  traceContext?: TraceCarrier;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * Bounded backoff for the "recipient resolution found nobody" case — see
 * `handleDomainEvent`'s doc comment for why this is needed at all. Short
 * and few: the source transaction this races against is typically just a
 * handful of remaining local writes away from committing, so the first or
 * second retry resolves it in practice; this is not meant to paper over a
 * genuinely-empty recipient list (e.g. a licensing event with no
 * TENANT_ADMIN), which just harmlessly exhausts the list and moves on.
 */
const EMPTY_RECIPIENTS_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The notification hub's PRODUCER side — see /CLAUDE.md § Conventions →
 * Notifications. `handleDomainEvent` is called by
 * `NotificationDispatchListener` for every domain event that
 * `isNotificationEventType` recognizes; everything it does (recipient
 * resolution, preference filtering, `Notification`/`NotificationDelivery`
 * row creation, queue enqueue) runs AFTER the triggering request's own
 * transaction/response, never inside it or awaited by it — see the
 * listener for exactly how that decoupling is achieved. This is what
 * satisfies "a slow/failing provider must never block or hang the API
 * request that triggered it": nothing here executes on the request's call
 * stack in a way the request waits on.
 *
 * Opens its OWN `withTenantContext` transaction (not
 * `TenantContextService.getTx()` — unavailable outside a request) to
 * create the DB rows, then enqueues one BullMQ job per created
 * `NotificationDelivery` AFTER that transaction commits — enqueuing
 * inside the transaction would risk a job referencing a row from a
 * transaction that could still roll back.
 *
 * THE RACE THIS RETRIES AROUND: every existing emitter (`AuthService`,
 * `WorkflowEngineService`, `LicensingAdminService`) calls
 * `eventEmitter.emit(...)` synchronously from INSIDE its own still-open
 * request transaction, often before that transaction has finished doing
 * everything the event describes (e.g. `WorkflowEngineService.startInstance`
 * emits `workflow.submitted` before it activates the first step and
 * resolves `eligibleApproverIds`). This listener's dispatch runs
 * fire-and-forget (see `NotificationDispatchListener`), in ITS OWN
 * transaction, which — being a separate Postgres transaction — cannot see
 * the emitting request's writes until that request's transaction commits.
 * A recipient resolver that depends on such just-written, not-yet-committed
 * state (like `workflow.submitted`'s active-step lookup) can race and see
 * nothing. Rather than requiring every current and future recipient
 * resolver to defensively retry internally, `EMPTY_RECIPIENTS_RETRY_DELAYS_MS`
 * gives the WHOLE resolve-and-create step a few short, bounded retries
 * whenever it finds zero recipients, before giving up.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly recipientResolver: NotificationRecipientResolverService,
    private readonly preferences: NotificationPreferenceService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue<DeliverNotificationJobData>,
  ) {}

  async handleDomainEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (!isNotificationEventType(eventType)) {
      return;
    }
    const tenantId = payload.tenantId as string | undefined;
    if (!tenantId) {
      this.logger.warn(`Domain event "${eventType}" has no tenantId — cannot dispatch notifications for it.`);
      return;
    }

    let deliveryIds: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const result = await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
        const recipients = await this.recipientResolver.resolve(tx, eventType, payload);
        const ids: string[] = [];

        for (const recipientUserId of recipients) {
          const channels = await this.preferences.resolveEnabledChannels(tx, recipientUserId, eventType);
          if (channels.length === 0) {
            continue;
          }

          const notification = await tx.notification.create({
            data: { tenantId, recipientUserId, eventType, payload: payload as Prisma.InputJsonValue },
          });

          for (const channel of channels) {
            const delivery = await tx.notificationDelivery.create({
              data: { tenantId, notificationId: notification.id, channel, status: 'PENDING' },
            });
            ids.push(delivery.id);
          }
        }

        return { recipientCount: recipients.length, ids };
      });

      deliveryIds = result.ids;
      if (result.recipientCount > 0 || attempt >= EMPTY_RECIPIENTS_RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(EMPTY_RECIPIENTS_RETRY_DELAYS_MS[attempt]);
    }

    const traceContext = injectTraceContext();
    for (const notificationDeliveryId of deliveryIds) {
      await this.queue.add('deliver', { tenantId, notificationDeliveryId, traceContext }, JOB_OPTIONS);
    }
  }
}
