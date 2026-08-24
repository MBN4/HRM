import { SetMetadata } from '@nestjs/common';

export const IS_PLATFORM_KEY = 'hrm:isPlatform';

/**
 * Marks a route as belonging to the future vendor super-admin ("platform",
 * no-tenant) surface. This is a SEAM, not a working bypass:
 *
 *   - It is rejected outright unless `PLATFORM_MODE_ENABLED=true` — off by
 *     default, so declaring this decorator does nothing in a normal
 *     deployment until that's deliberately turned on.
 *   - Even when enabled, `TenantScopeInterceptor` opens NO database
 *     transaction for platform requests — `TenantContextService.getTx()`
 *     throws. There is no tenant-scoped data access path through platform
 *     context today, by construction, not by convention. Real RBAC- and
 *     audit-gated cross-tenant access for the vendor admin console is a
 *     later step (see /CLAUDE.md § Not yet built).
 *   - It never weakens tenant-request handling: a route without this
 *     decorator is completely unaffected by whether platform mode is on.
 */
export const PlatformRoute = () => SetMetadata(IS_PLATFORM_KEY, true);
