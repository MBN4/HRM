import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { DEFAULT_NOTIFICATION_CHANNELS, NOTIFICATION_CHANNELS, NotificationChannel, NotificationEventType } from '@hrm/shared';

/**
 * PREFERENCES — see /CLAUDE.md § Conventions → Notifications → Preferences.
 * Absence of a `NotificationPreference` row for a given
 * `(userId, eventType, channel)` means "use the default"
 * (`DEFAULT_NOTIFICATION_CHANNELS[eventType]`); a row, when present,
 * always wins — it can either suppress a channel that's on by default or
 * opt into one that isn't.
 */
@Injectable()
export class NotificationPreferenceService {
  async resolveEnabledChannels(
    tx: Prisma.TransactionClient,
    userId: string,
    eventType: NotificationEventType,
  ): Promise<NotificationChannel[]> {
    const defaults = new Set<NotificationChannel>(DEFAULT_NOTIFICATION_CHANNELS[eventType] ?? []);
    const overrides = await tx.notificationPreference.findMany({ where: { userId, eventType } });
    const overrideByChannel = new Map(overrides.map((row) => [row.channel, row.enabled]));

    return NOTIFICATION_CHANNELS.filter((channel) =>
      overrideByChannel.has(channel) ? overrideByChannel.get(channel)! : defaults.has(channel),
    );
  }

  async listForUser(tx: Prisma.TransactionClient, userId: string) {
    return tx.notificationPreference.findMany({ where: { userId }, orderBy: [{ eventType: 'asc' }, { channel: 'asc' }] });
  }

  async setPreferences(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    preferences: Array<{ eventType: NotificationEventType; channel: NotificationChannel; enabled: boolean }>,
  ): Promise<void> {
    for (const pref of preferences) {
      await tx.notificationPreference.upsert({
        where: { tenantId_userId_eventType_channel: { tenantId, userId, eventType: pref.eventType, channel: pref.channel } },
        update: { enabled: pref.enabled },
        create: { tenantId, userId, eventType: pref.eventType, channel: pref.channel, enabled: pref.enabled },
      });
    }
  }
}
