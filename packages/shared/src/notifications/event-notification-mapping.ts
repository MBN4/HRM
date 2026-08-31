import { NotificationChannel } from './channel';

/**
 * The EVENT -> NOTIFICATION mapping layer — see /CLAUDE.md § Conventions →
 * Notifications. Every domain event type here corresponds 1:1 with the
 * event name already emitted by an existing module (`auth-events.ts`,
 * `licensing-events.ts`, `workflow-events.ts` in `apps/api`) — this file
 * does not introduce new events, it just says which of the EXISTING ones
 * the notification hub reacts to, and which channels they go out on by
 * default. An event type absent from this list is simply not mapped to a
 * notification (e.g. `auth.login`, `workflow.step_approved`) — the hub's
 * listener no-ops for anything not present here, so adding a new mapped
 * event later is a one-line data change, never new listener code.
 *
 * This is intentionally PURE DATA (no DB/recipient-resolution logic) so it
 * can live in `packages/shared` with no dependency on `@hrm/db` — WHO
 * actually receives a given event (e.g. "the workflow instance's current
 * approvers", "every TENANT_ADMIN in the tenant") is business logic that
 * needs a database query and lives in
 * `apps/api/src/notifications/notification-recipient-resolver.service.ts`
 * instead.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'auth.password_reset_requested',
  'workflow.submitted',
  'workflow.approved',
  'workflow.rejected',
  'workflow.escalated',
  'licensing.issued',
  'licensing.revoked',
  'payroll.payslip_ready',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationEventType(type: string): type is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type);
}

/** Sensible defaults — overridable per user via `NotificationPreference` (see NotificationPreferenceService). */
export const DEFAULT_NOTIFICATION_CHANNELS: Record<NotificationEventType, readonly NotificationChannel[]> = {
  'auth.password_reset_requested': ['EMAIL', 'IN_APP'],
  'workflow.submitted': ['IN_APP'],
  'workflow.approved': ['IN_APP'],
  'workflow.rejected': ['IN_APP'],
  'workflow.escalated': ['IN_APP', 'EMAIL'],
  'licensing.issued': ['IN_APP'],
  'licensing.revoked': ['IN_APP'],
  'payroll.payslip_ready': ['IN_APP', 'EMAIL'],
};
