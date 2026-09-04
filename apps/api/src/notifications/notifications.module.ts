import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrandingModule } from '../branding/branding.module';
import { NOTIFICATIONS_QUEUE } from '../queue/queue.constants';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationLocaleResolverService } from './notification-locale-resolver.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientResolverService } from './notification-recipient-resolver.service';
import { NotificationTemplateRenderer } from './notification-template-renderer.service';
import { NotificationDispatchListener } from './listeners/notification-dispatch.listener';
import { NotificationProcessor } from './notification.processor';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EMAIL_PROVIDER, PUSH_PROVIDER, SLACK_PROVIDER, SMS_PROVIDER } from './providers/notification-provider.tokens';
import { LogEmailProvider } from './providers/log-email.provider';
import { LogPushProvider } from './providers/log-push.provider';
import { LogSmsProvider } from './providers/log-sms.provider';
import { SlackNotificationProvider } from './providers/slack.provider';

/**
 * THE notification hub (step 0.8) — see /CLAUDE.md § Conventions →
 * Notifications for the full write-up. `BullModule.registerQueue({name:
 * NOTIFICATIONS_QUEUE})` is the worked example other modules should copy
 * for their own future queues (see `QueueModule`'s doc comment) —
 * `defaultJobOptions` here just seeds a default for jobs added without
 * their own; `NotificationsService` always passes explicit
 * attempts/backoff per job.
 *
 * The three `*_PROVIDER` bindings are this step's swappable seam: a real
 * deployment replaces `useClass: LogXxxProvider` with a real SES/Twilio/
 * FCM-backed class implementing the same `NotificationProvider` interface
 * — nothing else in this module, or any caller, changes.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: NOTIFICATIONS_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
    // Step 4.3 — NotificationTemplateRenderer/NotificationDeliveryService
    // resolve the tenant's branded product name (every template) and
    // email sender identity (EMAIL channel only) via
    // BrandingResolutionService. BrandingModule doesn't import this
    // module back, so this is not circular.
    BrandingModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationRecipientResolverService,
    NotificationPreferenceService,
    NotificationLocaleResolverService,
    NotificationTemplateRenderer,
    NotificationDeliveryService,
    NotificationDispatchListener,
    NotificationProcessor,
    { provide: EMAIL_PROVIDER, useClass: LogEmailProvider },
    { provide: SMS_PROVIDER, useClass: LogSmsProvider },
    { provide: PUSH_PROVIDER, useClass: LogPushProvider },
    // Step 3.3 (Integrations) — the one channel bound to a REAL adapter
    // rather than a dev-only Log*Provider; see SlackNotificationProvider.
    { provide: SLACK_PROVIDER, useClass: SlackNotificationProvider },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
