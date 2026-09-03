/**
 * The four notification channels — see /CLAUDE.md § Conventions →
 * Notifications for the full write-up. Kept as a plain literal tuple (not
 * re-derived from the Prisma enum) so `packages/shared` has no dependency
 * on `@hrm/db`, the same posture every other shared constant in this
 * package already takes.
 */
// SLACK added in step 3.3 (Integrations) — a real adapter reusing this exact
// provider seam, resolving `to` as the tenant's configured Slack incoming-
// webhook URL rather than a per-recipient address, the same way PUSH
// resolves `to` from User.pushToken. Opt-in only (absent from
// DEFAULT_NOTIFICATION_CHANNELS) — see docs/conventions/integrations.md.
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'SLACK'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
