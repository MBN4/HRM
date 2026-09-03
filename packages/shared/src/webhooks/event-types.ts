/**
 * The webhook-eligible event catalog — step 3.3 (Integrations). See
 * /CLAUDE.md § Conventions → Integrations for the full write-up.
 *
 * Same posture as `NOTIFICATION_EVENT_TYPES` (0.8): this is PURE DATA, no
 * DB dependency, and does not introduce any new domain event — every entry
 * here corresponds 1:1 with an event name already emitted by an existing
 * module (`auth-events.ts`/`licensing-events.ts`/`workflow-events.ts` in
 * `apps/api`, plus the inline string literals `payroll.payslip_ready`/
 * `performance.cycle_opened`/`performance.review_due`/
 * `recruitment.offer_accepted`/`checklist.task_assigned`/
 * `helpdesk.ticket_escalated`/`lms.course_assigned`/
 * `lms.certification_expiring`/`lms.certification_expired`). A tenant
 * subscribes a webhook endpoint to a SUBSET of this list
 * (`WebhookSubscription.eventTypes`); `WebhookDispatchListener` mirrors the
 * exact same `@OnEvent(...)` wildcard namespaces
 * `NotificationDispatchListener` already subscribes to, so no event
 * emitter anywhere needed to change for this step to exist.
 *
 * `auth.password_reset_requested` is deliberately EXCLUDED — its payload
 * carries a live, sensitive one-time reset token (see auth-rbac.md/
 * notifications-queues.md); exposing that to an arbitrary tenant-configured
 * external endpoint would hand out a credential-reset secret over the
 * network. Every other event type is otherwise passed through
 * `redactSensitiveFields` before signing, the same audit-redaction pass
 * `AuditRecordService`/`DomainEventAuditListener` already apply, as a second
 * line of defense.
 */
export const WEBHOOK_EVENT_TYPES = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.logout_all',
  'auth.password_changed',
  'auth.password_reset_completed',
  'auth.refresh_reuse_detected',
  'licensing.issued',
  'licensing.revoked',
  'licensing.activation_completed',
  'licensing.flag_override_set',
  'licensing.seat_cap_exceeded',
  'workflow.submitted',
  'workflow.step_approved',
  'workflow.approved',
  'workflow.rejected',
  'workflow.escalated',
  'workflow.delegated',
  'workflow.canceled',
  'payroll.payslip_ready',
  'performance.cycle_opened',
  'performance.review_due',
  'recruitment.offer_accepted',
  'checklist.task_assigned',
  'helpdesk.ticket_escalated',
  'lms.course_assigned',
  'lms.certification_expiring',
  'lms.certification_expired',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(type: string): type is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

/** The `@OnEvent(...)` wildcard namespaces `WebhookDispatchListener` subscribes to — mirrors `NotificationDispatchListener`'s exact list (0.8/3.1/3.2). */
export const WEBHOOK_EVENT_NAMESPACES = [
  'auth.*',
  'licensing.*',
  'workflow.*',
  'payroll.*',
  'performance.*',
  'recruitment.*',
  'checklist.*',
  'helpdesk.*',
  'lms.*',
] as const;
