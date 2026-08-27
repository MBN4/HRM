/**
 * Structured domain events for every auth-worthy action, emitted by
 * `AuthService` via `@nestjs/event-emitter` and consumed by
 * `apps/api/src/audit/listeners/domain-event-audit.listener.ts`'s
 * `DomainEventAuditListener` (0.9), which persists them into `audit_log`
 * — keep this event name/payload contract stable, since that listener
 * depends on it without this module changing.
 */
export const AUTH_EVENTS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  PASSWORD_CHANGED: 'auth.password_changed',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  REFRESH_REUSE_DETECTED: 'auth.refresh_reuse_detected',
} as const;

export type AuthEventType = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

export interface AuthEventPayload {
  type: AuthEventType;
  tenantId: string;
  userId?: string;
  email?: string;
  /**
   * The one-time password-reset token — present ONLY on
   * `PASSWORD_RESET_REQUESTED`, so the notification hub (0.8) can render
   * it into the reset email without owning the Redis key scheme
   * `AuthService`/`TokenService` store it under. SENSITIVE: this field
   * carries a live credential-reset secret. 0.9's real audit-log
   * persistence (which replaces `AuditEventsListener`'s current
   * structured-log placeholder) MUST redact it before writing any
   * `auth.*` event to durable storage — do not carry it forward
   * unredacted when that lands.
   */
  token?: string;
}
