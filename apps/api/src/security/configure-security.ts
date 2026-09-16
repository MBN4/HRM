import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { CorsOriginService } from './cors-origin.service';

/**
 * Phase 6.3 (edge security) — the DEFAULT-deny half of "a CDN caching
 * mistake is a cross-tenant data leak" (see
 * docs/conventions/edge-security.md → CDN and
 * `cache-control.interceptor.ts`'s own doc comment for the explicit-opt-IN
 * other half). Sets `Cache-Control: no-store` on EVERY response as early
 * as plain Express middleware can run — before tenant resolution, before
 * any guard/interceptor, before a route is even matched — so it applies
 * uniformly to every outcome (2xx, a 401 thrown by `TenantScopeInterceptor`,
 * a 403 from a guard, an unhandled 500) with zero dependency on Nest
 * interceptor nesting order, the same class of hazard 0.10's own load-
 * shedding/timeout logic already had to route around by NOT being a
 * separate global interceptor. A handler that sets its OWN
 * `Cache-Control` later (this middleware's default, or
 * `CacheControlInterceptor`'s explicit public-cache override, or
 * `BrandingController`'s own manual `private, max-age=300`) simply
 * OVERWRITES this value — `res.setHeader` always replaces, never
 * appends — so nothing here needs to special-case those routes.
 */
function defaultCacheControlMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Secure headers + CORS allow-list (step 6.2) — factored out of `main.ts`
 * so the e2e suite can exercise the SAME wiring against its own
 * `TestingModule`-built app, without duplicating the config. The exact
 * "factor out of main.ts so tests can set it up too" shape `setupSwagger`
 * already established (see that file's own doc comment).
 */
export function configureSecurity(app: INestApplication): void {
  // CSP is tuned, not left at helmet's strict default: `swagger-ui-express`
  // (mounted at /v1/docs by setupSwagger) serves an HTML page with an
  // inline bootstrap `<script>` and inline `<style>`, so `script-src`/
  // `style-src` need `'unsafe-inline'` for that ONE page to keep working —
  // documented here rather than silently disabling CSP for the whole app.
  // TLS itself is terminated at the load balancer/ingress in every real
  // deployment (see deploy/k8s/), never inside this process — `hsts` still
  // makes sense to set here since it's a response header, not a listener
  // option.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // A real allow-list (env-driven base domain + subdomains + verified
  // tenant custom domains, see CorsOriginService), replacing the previous
  // `app.enableCors()` with NO options at all (any origin). `credentials:
  // true` because the portal/admin/mobile clients all rely on this API
  // accepting `Authorization` headers from a browser context.
  const corsOriginService = app.get(CorsOriginService);
  app.enableCors({
    origin: (origin, callback) => {
      corsOriginService
        .isAllowed(origin)
        .then((allowed) => callback(null, allowed))
        .catch((error: unknown) => callback(error as Error, false));
    },
    credentials: true,
  });

  app.use(defaultCacheControlMiddleware);
}
