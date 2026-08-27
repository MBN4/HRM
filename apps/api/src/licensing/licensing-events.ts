/**
 * Structured domain events for every licensing-worthy action, emitted via
 * `@nestjs/event-emitter` and consumed by
 * `apps/api/src/audit/listeners/domain-event-audit.listener.ts`'s
 * `DomainEventAuditListener` (0.9), which persists them into `audit_log`
 * — the same contract `auth-events.ts` documents, without this module
 * changing.
 */
export const LICENSING_EVENTS = {
  ISSUED: 'licensing.issued',
  REVOKED: 'licensing.revoked',
  ACTIVATION_COMPLETED: 'licensing.activation_completed',
  FLAG_OVERRIDE_SET: 'licensing.flag_override_set',
  SEAT_CAP_EXCEEDED: 'licensing.seat_cap_exceeded',
} as const;

export type LicensingEventType = (typeof LICENSING_EVENTS)[keyof typeof LICENSING_EVENTS];

export interface LicensingEventPayload {
  type: LicensingEventType;
  tenantId: string;
  [key: string]: unknown;
}
