import { SetMetadata } from '@nestjs/common';
import type { PlatformPermissionKey } from '@hrm/shared';

export const REQUIRE_PLATFORM_PERMISSIONS_KEY = 'hrm:requiredPlatformPermissions';

/**
 * Deny-by-default route guard for the platform surface — the caller must
 * hold EVERY listed permission (per `@hrm/shared`'s
 * `PLATFORM_ROLE_PERMISSIONS[role]`, a fixed code table, never a DB read —
 * see docs/conventions/vendor-console.md for why platform roles aren't
 * tenant-style editable RBAC) or the request is rejected with 403.
 * Enforced by `PlatformPermissionsGuard`, the platform-context sibling of
 * `PermissionsGuard` (0.4) — same "interceptor, not a CanActivate guard"
 * reasoning: the platform admin's role is only known once
 * `TenantScopeInterceptor`'s interceptor-phase authentication has run.
 */
export const RequirePlatformPermissions = (...permissions: PlatformPermissionKey[]) =>
  SetMetadata(REQUIRE_PLATFORM_PERMISSIONS_KEY, permissions);
