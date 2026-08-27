import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { NotificationChannel, NotificationProvider } from '@hrm/shared';
import { CircuitBreakerService } from '../resilience/circuit-breaker/circuit-breaker.service';
import { NotificationLocaleResolverService } from './notification-locale-resolver.service';
import { NotificationTemplateRenderer, RenderedNotification } from './notification-template-renderer.service';
import { EMAIL_PROVIDER, PUSH_PROVIDER, SMS_PROVIDER } from './providers/notification-provider.tokens';

/**
 * The notification hub's CONSUMER side — the actual per-channel delivery
 * one BullMQ job performs. See /CLAUDE.md § Conventions → Notifications →
 * Async delivery. Runs entirely inside the WORKER process/tick, never on
 * a request's call stack.
 *
 * `IN_APP` has no external provider call — the `NotificationDelivery` row
 * itself IS the in-app notification, so "delivering" it is just rendering
 * + marking it `SENT`. Every other channel calls the matching
 * `NotificationProvider` (see providers/) after rendering.
 *
 * Uses SEPARATE `withTenantContext` transactions for the initial read,
 * the render+send step, and the final status write — deliberately NOT one
 * transaction wrapping the whole method: if "record FAILED and re-throw
 * for BullMQ to retry" happened inside the same transaction as the
 * re-throw, the throw would roll that write back along with it, silently
 * losing the failure record.
 *
 * Retry/dead-letter: on failure, always records `attempts`/`lastError`.
 * If this was NOT the job's final BullMQ attempt, re-throws so BullMQ
 * retries with its configured backoff (see `NotificationsService`'s
 * `JOB_OPTIONS`); on the FINAL attempt, the failure is recorded as
 * `DEAD_LETTER` and NOT re-thrown — BullMQ's open-source tier has no
 * separate dead-letter queue primitive, so "no further retry, permanently
 * marked" is expressed as durable DB state instead of a second physical
 * queue.
 *
 * Step 0.10: every provider `.send()` call now runs through
 * `CircuitBreakerService` (one breaker per CHANNEL — `notification-provider:EMAIL`,
 * `:SMS`, `:PUSH` — a channel's provider tripping shouldn't affect the
 * others) — see /CLAUDE.md § Conventions → Circuit breakers. A tripped
 * breaker's `CircuitOpenError` flows into the SAME catch block below as
 * any other send failure: it becomes `lastError`, counts toward
 * `attempts`, and follows the same retry-then-dead-letter path — no
 * special-casing needed, "the dependency is circuit-broken" is just
 * another reason a delivery attempt failed.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly localeResolver: NotificationLocaleResolverService,
    private readonly renderer: NotificationTemplateRenderer,
    private readonly circuitBreaker: CircuitBreakerService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: NotificationProvider,
    @Inject(SMS_PROVIDER) private readonly smsProvider: NotificationProvider,
    @Inject(PUSH_PROVIDER) private readonly pushProvider: NotificationProvider,
  ) {}

  async deliver(tenantId: string, notificationDeliveryId: string, attemptsMade: number, maxAttempts: number): Promise<void> {
    const delivery = await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
      tx.notificationDelivery.findUnique({ where: { id: notificationDeliveryId }, include: { notification: true } }),
    );
    // Already terminal (a retried job racing a prior successful attempt,
    // or a delivery for a since-deleted notification) — nothing to do.
    if (!delivery || delivery.status === 'SENT' || delivery.status === 'DEAD_LETTER') {
      return;
    }

    try {
      const rendered = await this.renderAndSend(
        tenantId,
        delivery.notification.eventType,
        delivery.channel,
        delivery.notification.recipientUserId,
        delivery.notification.payload as Record<string, unknown>,
      );

      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        tx.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            renderedSubject: rendered.subject,
            renderedBody: rendered.body,
            attempts: { increment: 1 },
          },
        }),
      );
    } catch (error) {
      const isFinalAttempt = attemptsMade + 1 >= maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        tx.notificationDelivery.update({
          where: { id: delivery.id },
          data: { attempts: { increment: 1 }, lastError: message, status: isFinalAttempt ? 'DEAD_LETTER' : 'FAILED' },
        }),
      );
      if (!isFinalAttempt) {
        throw error;
      }
      this.logger.warn(`Notification delivery "${delivery.id}" dead-lettered after ${maxAttempts} attempts: ${message}`);
    }
  }

  /** Resolves locale + renders the template, then — for every channel but IN_APP — calls the matching provider. */
  private async renderAndSend(
    tenantId: string,
    eventType: string,
    channel: NotificationChannel,
    recipientUserId: string,
    payload: Record<string, unknown>,
  ): Promise<RenderedNotification> {
    return withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const locale = await this.localeResolver.resolveRecipientLocale(tx, tenantId, recipientUserId);
      const rendered = await this.renderer.render(tx, eventType, channel, locale.language, payload);

      if (channel !== 'IN_APP') {
        const recipient = await tx.user.findUniqueOrThrow({ where: { id: recipientUserId }, select: { id: true, email: true } });
        const to = channel === 'EMAIL' ? recipient.email : recipient.id;
        const provider = this.providerFor(channel);
        await this.circuitBreaker.execute(`notification-provider:${channel}`, () =>
          provider.send({
            recipientUserId: recipient.id,
            to,
            subject: rendered.subject,
            body: rendered.body,
            locale: locale.language,
          }),
        );
      }

      return rendered;
    });
  }

  private providerFor(channel: Exclude<NotificationChannel, 'IN_APP'>): NotificationProvider {
    switch (channel) {
      case 'EMAIL':
        return this.emailProvider;
      case 'SMS':
        return this.smsProvider;
      case 'PUSH':
        return this.pushProvider;
      default:
        throw new Error(`No provider is bound for channel "${channel}".`);
    }
  }
}
