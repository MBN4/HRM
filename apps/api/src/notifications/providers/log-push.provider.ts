import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';

/**
 * Dev/no-op push provider. No device-token field exists on `User` yet —
 * same rationale as `log-sms.provider.ts`. A real FCM-backed provider
 * swapped in later resolves an actual device token instead of this
 * placeholder.
 */
@Injectable()
export class LogPushProvider implements NotificationProvider {
  private readonly logger = new Logger('PushProvider(dev)');

  async send(params: NotificationProviderSendParams): Promise<void> {
    this.logger.log(`[DEV PUSH] to=${params.to} locale=${params.locale} body="${params.body}"`);
  }
}
