import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../notifications/channel';
import { NOTIFICATION_EVENT_TYPES } from '../notifications/event-notification-mapping';

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

/** `PUT /notifications/preferences` body — an explicit opt-in/opt-out per (eventType, channel). Unlisted pairs keep whatever they already were (default or previously-set). */
export const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        eventType: notificationEventTypeSchema,
        channel: notificationChannelSchema,
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(100),
});
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
