import { SetMetadata } from '@nestjs/common';

export const IS_ALLOW_ANONYMOUS_KEY = 'hrm:isAllowAnonymous';

/**
 * Marks a route as not requiring a JWT — but, unlike `@Public()`, tenant
 * resolution still applies and the request still runs inside the tenant's
 * transaction. For login/refresh/request-password-reset/reset-password:
 * they need to resolve and scope to a tenant to look up the right user,
 * they just don't have a token to check yet (that's what they're for).
 */
export const AllowAnonymous = () => SetMetadata(IS_ALLOW_ANONYMOUS_KEY, true);
