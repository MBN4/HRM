import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContextStorage } from './request-context.store';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Phase 5.4 — plain Express middleware (`app.use(...)` in `main.ts`, so it
 * runs BEFORE `TenantScopeInterceptor` and every other interceptor/guard —
 * Express middleware ordering is deterministic by registration order,
 * unlike the `APP_INTERCEPTOR` ordering pitfall `resilience.md` documents
 * for TWO interceptors registered in different MODULES, so there is no
 * ordering risk here to prove out). Accepts an inbound `X-Request-Id` (a
 * caller-supplied trace id, e.g. from an API gateway or another internal
 * service) or generates a fresh UUID, echoes it back on the response, and
 * runs the rest of the request inside `requestContextStorage.run(...)` so
 * every log line emitted anywhere during this request — including one
 * from `LoadSheddingService` rejecting it before tenant resolution even
 * starts — carries the same id.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  requestContextStorage.run({ requestId }, () => next());
}
