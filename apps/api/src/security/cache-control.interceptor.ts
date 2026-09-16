import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { CACHE_CONTROL_KEY, CacheControlPublicOptions } from './cache-control.decorator';

/**
 * Phase 6.3 (edge security) — the explicit-opt-IN half of "a CDN caching
 * mistake is a cross-tenant data leak" (see docs/conventions/edge-security.md
 * → CDN). The DEFAULT-deny half — every response gets `Cache-Control:
 * no-store` unless something more specific overrides it — is
 * `defaultCacheControlMiddleware` (`configure-security.ts`), plain Express
 * middleware that runs before Nest's own routing/interceptor pipeline even
 * starts, so it applies uniformly to every outcome (a 2xx, a 4xx thrown by
 * a guard, a 401 thrown by `TenantScopeInterceptor` before this
 * interceptor's route is ever matched, a 5xx) with no dependency on
 * interceptor nesting order at all.
 *
 * THIS interceptor is deliberately route-scoped
 * (`@UseInterceptors(CacheControlInterceptor)`, applied alongside
 * `@CacheControlPublic(...)` at each cacheable route — see
 * `CareersController`), never a global `APP_INTERCEPTOR` — the SAME
 * reasoning `TenantScopeInterceptor`'s own doc comment gives for why load
 * shedding/the timeout/rate limiting must be called directly rather than
 * registered as a second global interceptor: this codebase's own
 * `resilience.e2e-spec.ts` empirically proved Nest does NOT reliably order
 * `APP_INTERCEPTOR`s registered in different modules relative to each
 * other. A route-scoped interceptor sidesteps that hazard entirely — Nest
 * applies `@UseInterceptors()` deterministically around just that route's
 * own handler, no cross-module ordering question to get wrong. Only ever
 * needs to run its `tap()` for the routes it's explicitly attached to
 * (both success AND the route's own error responses, e.g. the careers
 * API's 404 for an unknown slug — still a PUBLIC, non-sensitive response,
 * safe for a shared cache).
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const options = this.reflector.getAllAndOverride<CacheControlPublicOptions | undefined>(CACHE_CONTROL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) {
      return next.handle();
    }

    const response = context.switchToHttp().getResponse<Response>();
    const swr =
      options.staleWhileRevalidateSeconds !== undefined ? `, stale-while-revalidate=${options.staleWhileRevalidateSeconds}` : '';
    const applyHeader = () =>
      response.setHeader('Cache-Control', `public, max-age=${options.maxAgeSeconds}, s-maxage=${options.maxAgeSeconds}${swr}`);

    return next.handle().pipe(tap({ next: applyHeader, error: applyHeader }));
  }
}
