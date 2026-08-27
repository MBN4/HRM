import { SetMetadata } from '@nestjs/common';

export const AUDIT_LOG_KEY = 'hrm:auditLog';

export interface AuditLogMetadata {
  entityType: string;
  action: string;
}

/**
 * Marks a route as an audited mutation. Paired with
 * `@UseInterceptors(AuditInterceptor)` (same "decorator carries metadata,
 * a route-scoped interceptor reads it and does the work" shape as
 * `@RequirePermissions()` + `PermissionsGuard`, `@RequireFeature()` +
 * `FeatureFlagGuard`) — see audit.interceptor.ts for what actually gets
 * written. `entityId` is resolved by the interceptor itself from the
 * response body's `id` field (falling back to the `:id`-shaped route
 * param, if any); there is no need to pass it here.
 */
export const AuditLog = (entityType: string, action: string) =>
  SetMetadata(AUDIT_LOG_KEY, { entityType, action } satisfies AuditLogMetadata);
