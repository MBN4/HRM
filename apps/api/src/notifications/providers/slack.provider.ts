import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider, NotificationProviderSendParams } from '@hrm/shared';

/**
 * Step 3.3 (Integrations) — a real (not a `Log*Provider` dev stub) adapter
 * satisfying the SAME `NotificationProvider` interface every other channel
 * provider does, posting into a tenant's Slack incoming webhook. `to` (see
 * `NotificationDeliveryService.resolveSlackWebhookUrl`) IS the decrypted
 * webhook URL for this tenant — this class has no DB/tenant awareness of
 * its own, matching every other provider's "pure I/O, no lookups" shape.
 *
 * Wrapped by the SAME `CircuitBreakerService.execute('notification-provider:SLACK', ...)`
 * call every other channel already goes through (see
 * `NotificationDeliveryService`) — a broken/rate-limited Slack endpoint
 * trips its OWN breaker, isolated from EMAIL/SMS/PUSH, with zero special-
 * casing needed here.
 */
@Injectable()
export class SlackNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger('SlackProvider');

  async send(params: NotificationProviderSendParams): Promise<void> {
    const text = params.subject ? `*${params.subject}*\n${params.body}` : params.body;
    const response = await fetch(params.to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Slack webhook responded ${response.status}: ${body.slice(0, 500)}`);
    }
    this.logger.debug(`Slack notification posted (locale=${params.locale}).`);
  }
}
