import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider } from '@hrm/shared';
import { EMAIL_PROVIDER } from '../notifications/providers/notification-provider.tokens';

/**
 * Delivery for EXTERNAL signers (no `User` row at all — a candidate
 * signing an offer letter before joining is the reference case) — see
 * docs/conventions/e-signatures.md → Notifications. The real 0.8
 * notification hub is entirely User-keyed (`Notification.recipientUserId`,
 * `NotificationPreference`, locale resolution off a `User`'s own
 * branch/`preferredLanguage`) — there is no recipient row to route through
 * for someone who never had one, so this service calls the SAME
 * `EMAIL_PROVIDER` DI token directly instead of going through
 * `NotificationsService`/`NotificationDeliveryService`. This is still full
 * reuse of the provider SEAM (swap one binding in `notifications.module.ts`
 * and both this service and the hub pick up a real ESP with zero further
 * changes) — only the request→transaction/retry/dead-letter/BullMQ
 * machinery around it is bypassed, since none of that machinery knows how
 * to key a `Notification` row to a non-`User` recipient.
 *
 * Deliberately best-effort: a failed send here is logged, never thrown —
 * the signing link itself remains valid regardless (an admin/HR user can
 * always re-fetch it via `GET /e-signatures/requests/:id` and relay it
 * out-of-band), mirroring this codebase's "an audit/notification-sink
 * failure must never look like the action itself failed" posture.
 */
@Injectable()
export class ExternalSignerNotifierService {
  private readonly logger = new Logger(ExternalSignerNotifierService.name);

  constructor(@Inject(EMAIL_PROVIDER) private readonly emailProvider: NotificationProvider) {}

  async notifySigningLink(params: { signerId: string; to: string; requestTitle: string; signingUrl: string }): Promise<void> {
    await this.send(
      params.signerId,
      params.to,
      `You have a document to sign: ${params.requestTitle}`,
      `You have been asked to review and sign "${params.requestTitle}". Use this link to view and sign it: ${params.signingUrl}\n\n` +
        'This link is single-use and will expire — if it has expired, contact the sender for a new one.',
    );
  }

  private async send(signerId: string, to: string, subject: string, body: string): Promise<void> {
    try {
      await this.emailProvider.send({
        // No real `User` exists for an external signer — this field is only
        // ever read by `NotificationDeliveryService`'s own machinery, which
        // this direct call bypasses entirely; the signer's own id is passed
        // through purely so a provider's logs/traces can still correlate a
        // send back to a signer.
        recipientUserId: signerId,
        to,
        subject,
        body,
        locale: 'en',
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to email external signer "${signerId}": ${String(error)}`);
    }
  }
}
