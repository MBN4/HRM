import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NOTIFICATIONS_QUEUE } from '../queue/queue.constants';
import { shouldAutorunWorkers } from '../queue/queue-worker.util';
import type { DeliverNotificationJobData } from './notifications.service';
import { NotificationDeliveryService } from './notification-delivery.service';

/**
 * The BullMQ worker for the `notifications` queue — see /CLAUDE.md §
 * Conventions → Notifications → Async delivery (BullMQ) for the full
 * write-up, and `QueueModule` for the reusable pattern this instantiates.
 * `process()` is BullMQ's per-job entry point; all the actual delivery
 * logic lives in `NotificationDeliveryService` so this class stays a thin
 * adapter between BullMQ's `Job` shape and that service's plain method
 * signature.
 */
@Processor(NOTIFICATIONS_QUEUE, { autorun: shouldAutorunWorkers() })
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly delivery: NotificationDeliveryService) {
    super();
  }

  async process(job: Job<DeliverNotificationJobData>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    await this.delivery.deliver(job.data.tenantId, job.data.notificationDeliveryId, job.attemptsMade, maxAttempts);
  }
}
