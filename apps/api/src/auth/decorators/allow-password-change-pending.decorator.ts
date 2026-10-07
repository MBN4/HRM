import { SetMetadata } from '@nestjs/common';

export const IS_ALLOW_PASSWORD_CHANGE_PENDING_KEY = 'hrm:isAllowPasswordChangePending';

/**
 * Exempts an AUTHENTICATED route from the forced-first-login block (step
 * 7.1 — see docs/conventions/user-management.md). A user whose
 * `mustChangePassword` flag is still `true` (an HR-generated temporary
 * password) is rejected by `TenantScopeInterceptor` with a 403
 * `PASSWORD_CHANGE_REQUIRED` on EVERY route except the few that carry
 * this decorator: the first-login password change itself, `GET /auth/me`
 * (so the client can learn it must show the change screen), and
 * logout. Deny-by-default: a new route is blocked for such a user unless
 * it explicitly opts in here.
 */
export const AllowPasswordChangePending = () => SetMetadata(IS_ALLOW_PASSWORD_CHANGE_PENDING_KEY, true);
