import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { interpolateTemplate, NotificationChannel } from '@hrm/shared';

const FALLBACK_LOCALE = 'en';

export interface RenderedNotification {
  subject?: string;
  body: string;
}

/**
 * TEMPLATES + i18n — see /CLAUDE.md § Conventions → Notifications →
 * Templates. Loads the highest-version active `NotificationTemplate` for
 * `(eventType, channel, locale)`, falling back to `FALLBACK_LOCALE` ("en")
 * if the recipient's exact language has no template yet, then substitutes
 * `{{placeholder}}` tokens from the triggering event's payload. No
 * template for EITHER locale is a loud `NotFoundException` (consistent
 * with this project's "no missing_ok" posture — see /CLAUDE.md §
 * Conventions → Row-Level Security) rather than a silent blank
 * notification; inside the worker this surfaces as a job failure, which
 * is the correct outcome — a missing template is an ops/content gap that
 * should be visible (via retries -> dead-letter), not swallowed.
 */
@Injectable()
export class NotificationTemplateRenderer {
  async render(
    tx: Prisma.TransactionClient,
    eventType: string,
    channel: NotificationChannel,
    locale: string,
    payload: Record<string, unknown>,
  ): Promise<RenderedNotification> {
    const template = await this.findTemplate(tx, eventType, channel, locale);
    return {
      subject: template.subject ? interpolateTemplate(template.subject, payload) : undefined,
      body: interpolateTemplate(template.body, payload),
    };
  }

  private async findTemplate(tx: Prisma.TransactionClient, eventType: string, channel: NotificationChannel, locale: string) {
    const exact = await tx.notificationTemplate.findFirst({
      where: { eventType, channel, locale, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (exact) {
      return exact;
    }
    if (locale !== FALLBACK_LOCALE) {
      const fallback = await tx.notificationTemplate.findFirst({
        where: { eventType, channel, locale: FALLBACK_LOCALE, isActive: true },
        orderBy: { version: 'desc' },
      });
      if (fallback) {
        return fallback;
      }
    }
    throw new NotFoundException(
      `No notification template is configured for event "${eventType}", channel "${channel}", locale "${locale}" (or fallback "${FALLBACK_LOCALE}").`,
    );
  }
}
