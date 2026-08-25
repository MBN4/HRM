/**
 * Structured domain events for every licensing-worthy action, emitted via
 * `@nestjs/event-emitter` and consumed today only by
 * `licensing/listeners/licensing-events.listener.ts` (which just logs
 * them) — the same deferred-persistence pattern `auth-events.ts`
 * documents: 0.9's real audit log persists against this contract instead,
 * without this module changing.
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
