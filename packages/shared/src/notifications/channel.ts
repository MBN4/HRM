/**
 * The four notification channels — see /CLAUDE.md § Conventions →
 * Notifications for the full write-up. Kept as a plain literal tuple (not
 * re-derived from the Prisma enum) so `packages/shared` has no dependency
 * on `@hrm/db`, the same posture every other shared constant in this
 * package already takes.
 */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
