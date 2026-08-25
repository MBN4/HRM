import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';

/**
 * Dev/no-op SMS provider. No phone-number field exists on `User` yet (that
 * belongs to a future Employee/profile module, out of this step's scope)
 * — `to` is the recipient's userId as a placeholder destination; a real
 * Twilio-backed provider swapped in later would resolve an actual phone
 * number instead. See `log-email.provider.ts` for the full seam
 * rationale.
 */
@Injectable()
export class LogSmsProvider implements NotificationProvider {
  private readonly logger = new Logger('SmsProvider(dev)');

  async send(params: NotificationProviderSendParams): Promise<void> {
    this.logger.log(`[DEV SMS] to=${params.to} locale=${params.locale} body="${params.body}"`);
  }
}
