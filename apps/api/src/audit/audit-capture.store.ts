import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A small, SELF-CONTAINED `AsyncLocalStorage` for one thing only: letting a
 * route handler stash the pre-mutation "before" snapshot of whatever it's
 * about to change, for `AuditInterceptor` to pick up when it writes the
 * audit row after the handler resolves (see audit.interceptor.ts).
 *
 * Deliberately a SEPARATE storage from `tenant-context.store.ts`'s
 * `tenantContextStorage`, not an added field on `RequestTenantStore` — this
 * is scratch state for exactly one interceptor's bookkeeping, not part of
 * the tenant/auth identity the rest of the request relies on, and keeping
 * it isolated means nothing here can ever touch tenancy/auth core logic.
 * `AuditInterceptor` opens this storage's scope around `next.handle()` the
 * same way `TenantScopeInterceptor` opens `tenantContextStorage`'s (see
 * that file's doc comment) — AsyncLocalStorage context propagates through
 * the async chain started inside `.run()`, which is what lets a controller
 * method call `AuditCaptureService.setBefore()` deep inside its own
 * `async` body and have `AuditInterceptor` still see it afterwards.
 */
export interface AuditCaptureFrame {
  before: unknown;
}

export const auditCaptureStorage = new AsyncLocalStorage<AuditCaptureFrame>();
