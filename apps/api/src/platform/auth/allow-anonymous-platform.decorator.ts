import { SetMetadata } from '@nestjs/common';

export const IS_ALLOW_ANONYMOUS_PLATFORM_KEY = 'hrm:isAllowAnonymousPlatform';

/**
 * Marks a `@PlatformRoute()` as not requiring a platform admin bearer
 * token — the platform-context analogue of `@AllowAnonymous()` (0.4).
 * Reserved for the handful of routes that themselves ESTABLISH a platform
 * session (login, MFA enrollment/verification, refresh) — every other
 * `@PlatformRoute()` requires a fully authenticated, MFA-verified
 * `PlatformAdmin` by default (deny-by-default, the same posture the whole
 * rest of this codebase's RBAC takes). Still requires `PLATFORM_MODE_ENABLED=true`
 * — this decorator only skips the ADMIN-IDENTITY check, never the platform
 * seam's own on/off flag.
 */
export const AllowAnonymousPlatform = () => SetMetadata(IS_ALLOW_ANONYMOUS_PLATFORM_KEY, true);
