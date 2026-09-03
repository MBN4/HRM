import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { WEBHOOK_DELIVERY_QUEUE } from '../../queue/queue.constants';
import type { DeliverWebhookJobData } from './webhook-dispatch.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Processor(WEBHOOK_DELIVERY_QUEUE)
export class WebhookProcessor extends WorkerHost {
  constructor(private readonly delivery: WebhookDeliveryService) {
    super();
  }

  async process(job: Job<DeliverWebhookJobData>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    await this.delivery.deliver(job.data.tenantId, job.data.webhookDeliveryId, job.attemptsMade, maxAttempts);
  }
}
