import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { interpolateTemplate, NotificationChannel } from '@hrm/shared';
import { BrandingResolutionService } from '../branding/branding-resolution.service';

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
 *
 * Step 4.3 (white-label) — every render also merges in `{{productName}}`,
 * resolved via `BrandingResolutionService` (cached, hot-path-cheap), so
 * ANY template — today just the password-reset EMAIL/IN_APP templates,
 * see seed-notification-templates.ts — can reference the tenant's branded
 * product name instead of a hardcoded "HRM". An explicit `productName` key
 * already present in the triggering event's own payload wins (unlikely in
 * practice, but the merge order makes the precedence explicit).
 */
@Injectable()
export class NotificationTemplateRenderer {
  constructor(private readonly branding: BrandingResolutionService) {}

  async render(
    tx: Prisma.TransactionClient,
    tenantId: string,
    eventType: string,
    channel: NotificationChannel,
    locale: string,
    payload: Record<string, unknown>,
  ): Promise<RenderedNotification> {
    const template = await this.findTemplate(tx, eventType, channel, locale);
    const effectiveBranding = await this.branding.resolve(tx, tenantId);
    const vars = { productName: effectiveBranding.productName, ...payload };
    return {
      subject: template.subject ? interpolateTemplate(template.subject, vars) : undefined,
      body: interpolateTemplate(template.body, vars),
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
