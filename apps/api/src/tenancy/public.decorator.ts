import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'hrm:isPublic';

/**
 * Marks a route (or an entire controller) as not requiring tenant
 * resolution — e.g. health checks, and eventually login. `TenantScopeInterceptor`
 * skips resolution entirely for these and runs the handler with no tenant
 * context and no open transaction.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
