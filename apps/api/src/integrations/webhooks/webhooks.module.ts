import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WEBHOOK_DELIVERY_QUEUE } from '../../queue/queue.constants';
import { LicensingModule } from '../../licensing/licensing.module';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatchListener } from './webhook-dispatch.listener';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookProcessor } from './webhook.processor';
import { WebhookSubscriptionController } from './webhook-subscription.controller';
import { WebhookSubscriptionService } from './webhook-subscription.service';

/**
 * Outbound webhooks (step 3.3) — the SAME reusable BullMQ pattern
 * `QueueModule`'s doc comment names (`BullModule.registerQueue` + a
 * `@Processor` class), imported here exactly like `NotificationsModule`
 * imports it for its own queue. `LicensingModule` is imported for
 * `FeatureFlagGuard`'s dependency, the same reason `payroll.module.ts`/
 * `auth.module.ts` (SSO) already import it.
 */
@Module({
  imports: [
    LicensingModule,
    BullModule.registerQueue({
      name: WEBHOOK_DELIVERY_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [WebhookSubscriptionController],
  providers: [
    WebhookSubscriptionService,
    WebhookDispatchService,
    WebhookDispatchListener,
    WebhookDeliveryService,
    WebhookProcessor,
  ],
})
export class WebhooksModule {}
