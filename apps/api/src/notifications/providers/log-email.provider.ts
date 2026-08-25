import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';

/**
 * The dev/local EMAIL provider — logs the rendered message instead of
 * calling a real ESP, so the notification flow is fully exercisable with
 * no external dependency (matches this codebase's existing "log in dev,
 * real integration is later work" posture — see e.g. 0.4's password-reset
 * stub, which this provider now supersedes). A real deployment swaps this
 * ONE binding in `notifications.module.ts` (`{ provide: EMAIL_PROVIDER,
 * useClass: SesEmailProvider }` or similar) for Amazon SES / SMTP — no
 * caller of `EMAIL_PROVIDER` changes, the same seam shape 0.4's
 * `AUTH_PROVIDER` established for SSO. A local-SMTP-catcher provider
 * (Mailhog) is an equally valid drop-in later; it wasn't built here
 * because it would need a Mailhog container wired into `docker-compose.yml`
 * and CI, out of scope for proving the abstraction itself.
 */
@Injectable()
export class LogEmailProvider implements NotificationProvider {
  private readonly logger = new Logger('EmailProvider(dev)');

  async send(params: NotificationProviderSendParams): Promise<void> {
    this.logger.log(`[DEV EMAIL] to=${params.to} locale=${params.locale} subject="${params.subject ?? ''}" body="${params.body}"`);
  }
}
