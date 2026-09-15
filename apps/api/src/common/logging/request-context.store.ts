import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Phase 5.4 — the request/job correlation-id equivalent of
 * `tenancy/tenant-context.store.ts`'s `tenantContextStorage`: a raw,
 * DI-free `AsyncLocalStorage` any code (including `PinoLoggerService`,
 * constructed manually in `main.ts`/`worker.ts` BEFORE Nest's DI container
 * exists) can read from with a plain function call — see that file's own
 * doc comment for why continuation-local storage, not REQUEST-scoped DI,
 * is this codebase's established mechanism for per-request context.
 *
 * Deliberately SEPARATE from `RequestTenantStore` rather than adding a
 * field there: `RequestTenantStore` is populated at FIVE different call
 * sites inside `TenantScopeInterceptor` (public/platform/tenant/API-key/
 * anonymous branches — see that file), and every one of those already
 * constructs its own context object literal. Threading a `requestId`
 * through all five (right before `LOAD_SHEDDING`/rate-limit checks even
 * apply, since a shed/429 response should still be correlatable) would
 * mean editing that already-dense interceptor for a concern — log/trace
 * correlation — that has nothing to do with tenancy/auth. A second, tiny,
 * independent store set up by `RequestIdMiddleware` (plain Express
 * middleware, runs BEFORE any interceptor) is simpler and lower-risk:
 * `PinoLoggerService`/tracing code just reads BOTH stores independently
 * and merges whatever each has (tenant context is `undefined` for a
 * request that hasn't reached `TenantScopeInterceptor` yet, e.g. one
 * rejected by load shedding — the log line still carries a `requestId`
 * even then, which is exactly the point).
 */
export interface RequestLogContext {
  requestId: string;
  /**
   * Mirrors `tenantContextStorage`'s own `tenantId`/`userId`, set (via
   * `setRequestLogIdentity`) the moment `TenantScopeInterceptor` resolves
   * them. NOT the primary source of truth for correlation during normal
   * request handling — `PinoLoggerService` prefers the live
   * `tenantContextStorage` store, which is more complete (branch, roles,
   * ...) — this is a fallback for the one real gap found while testing
   * this exact mechanism: when a request throws from INSIDE a Postgres
   * transaction (`withTenantContext`), Prisma's own rollback round-trip
   * (a real async operation against its query engine) settles the
   * transaction's promise from a continuation Node's `AsyncLocalStorage`
   * does not track back to `tenantContextStorage`'s original `.run()` —
   * by the time Nest's default exception handling calls
   * `logger.error(...)`, that store is already gone, even though THIS
   * store (set up by plain Express middleware wrapping the entire
   * request, with no transaction in between) is still very much alive.
   * `apps/api/test/observability.e2e-spec.ts`'s error-tracking test is
   * what caught this — proven, not assumed — see
   * docs/conventions/observability-load.md § Logging.
   */
  tenantId?: string;
  userId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestLogContext>();

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export function getRequestLogIdentity(): { tenantId?: string; userId?: string } {
  const store = requestContextStorage.getStore();
  return { tenantId: store?.tenantId, userId: store?.userId };
}

/**
 * Mutates the CURRENT request's store in place (safe: `requestContextStorage`'s
 * store object is an ordinary mutable JS object — `AsyncLocalStorage` does
 * not freeze it — and any code reading `getStore()` later in the SAME
 * request sees the update). A no-op if called outside any request context
 * (e.g. from a BullMQ job, which never goes through `requestIdMiddleware`).
 */
export function setRequestLogIdentity(tenantId?: string, userId?: string): void {
  const store = requestContextStorage.getStore();
  if (!store) {
    return;
  }
  if (tenantId) {
    store.tenantId = tenantId;
  }
  if (userId) {
    store.userId = userId;
  }
}
