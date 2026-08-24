/**
 * Structured domain events for every auth-worthy action, emitted by
 * `AuthService` via `@nestjs/event-emitter` and consumed today only by
 * `AuditEventsListener` (which just logs them). This is the wiring point
 * 0.9's real audit log persists instead — keep the event name/payload
 * contract stable, since 0.9 depends on it without touching this module.
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
}
