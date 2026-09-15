import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Phase 5.4 — records `hrm_http_request_duration_seconds`/
 * `hrm_http_requests_total` for every request. Plain Express middleware
 * (`app.use(...)` in `main.ts`), not a hook inside `TenantScopeInterceptor`
 * — deliberately: timing needs to wrap the ENTIRE request from the
 * earliest possible point (including tenant resolution and the per-tenant
 * rate-limit check) for the latency number to mean anything, and `res.on
('finish', ...)` is the only point at which `res.statusCode` is reliably
 * FINAL (an interceptor's own `intercept()` resolves before Nest's
 * response-writing machinery actually decides the status code for the
 * success path). Route label uses `req.route.path` (the matched Express
 * ROUTE TEMPLATE, e.g. `/employees/:id`) — never `req.path` (the raw URL,
 * which would include real ids/tenant slugs and blow up cardinality) —
 * falling back to `(unmatched)` for a 404 that never reached a route.
 */
export function createHttpMetricsMiddleware(metrics: MetricsService) {
  return function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req.route as { path?: string } | undefined)?.path ?? '(unmatched)';
      metrics.recordHttpRequest(req.method, route, res.statusCode, durationSeconds);
    });
    next();
  };
}
