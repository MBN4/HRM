import { SetMetadata } from '@nestjs/common';

export const CACHE_CONTROL_KEY = 'hrm:cacheControlPublic';

export interface CacheControlPublicOptions {
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds?: number;
}

/**
 * Marks a route as safe for a CDN/shared cache to store — see
 * docs/conventions/edge-security.md → CDN. Every OTHER route (the
 * overwhelming majority: anything tenant-scoped, authenticated, or
 * otherwise not explicitly marked) gets `Cache-Control: no-store` by
 * DEFAULT from `CacheControlInterceptor` — this decorator is the single,
 * explicit opt-IN a route author must reach for, never the reverse. A
 * caching mistake in the other direction (a sensitive/tenant response
 * accidentally cached at a shared edge) is a cross-tenant data leak, not
 * a performance bug — see `apps/api/test/edge-cache-control.e2e-spec.ts`.
 *
 * Only ever apply this to a route that is:
 *   - genuinely public (`@AllowAnonymous()`/`@Public()` — no per-caller
 *     variation in the response at all), AND
 *   - safe to serve slightly stale to a DIFFERENT visitor than the one
 *     who produced the cached copy (a shared/CDN cache, by definition,
 *     serves the SAME cached bytes to every subsequent requester until
 *     the TTL expires).
 * The public careers API (`CareersController`) is this codebase's first
 * and, as of this step, only user.
 */
export const CacheControlPublic = (maxAgeSeconds: number, staleWhileRevalidateSeconds?: number) =>
  SetMetadata<string, CacheControlPublicOptions>(CACHE_CONTROL_KEY, { maxAgeSeconds, staleWhileRevalidateSeconds });
