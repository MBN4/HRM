import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSIONS_KEY = 'hrm:requiredPermissions';

/**
 * Deny-by-default route guard: the caller must hold EVERY listed
 * permission (checked against their current DB-loaded permission set, not
 * anything cached in a token) or the request is rejected with 403.
 * Enforced by `PermissionsGuard` — see that file for why it's applied via
 * `@UseInterceptors()` despite the name.
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(REQUIRE_PERMISSIONS_KEY, permissions);
