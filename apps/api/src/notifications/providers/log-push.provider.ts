import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';

/**
 * Dev/log-only push provider — `params.to` is the recipient's real
 * registered device token (`User.pushToken`, set via `POST
 * /auth/push-token`, step 1.4) when one exists, else the same user-id
 * placeholder `log-sms.provider.ts` uses. This provider only LOGS either
 * way; a real FCM/Expo-push-API-backed provider swapped in later (one DI
 * binding, same seam as every other channel) sends to `params.to` for
 * real instead.
 */
@Injectable()
export class LogPushProvider implements NotificationProvider {
  private readonly logger = new Logger('PushProvider(dev)');

  async send(params: NotificationProviderSendParams): Promise<void> {
    this.logger.log(`[DEV PUSH] to=${params.to} locale=${params.locale} body="${params.body}"`);
  }
}
