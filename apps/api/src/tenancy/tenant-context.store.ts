import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@hrm/db';

/**
 * Per-request tenant/user context. `branchId`, `userId`, and `roles` are
 * wired here but stay null until auth lands (0.4) — nothing populates them
 * yet. `tx` is the live Postgres transaction the whole request runs in
 * (opened by `TenantScopeInterceptor` via `withTenantContext`); it is null
 * for public and platform requests, which never open one.
 */
export interface RequestTenantStore {
  tenantId: string | null;
  branchId: string | null;
  userId: string | null;
  roles: string[] | null;
  /** True only for requests through an explicit @PlatformRoute() — see platform-route.decorator.ts. */
  platform: boolean;
  tx: Prisma.TransactionClient | null;
}

/**
 * Node's continuation-local storage, not a global mutable singleton: each
 * concurrent request gets its own store instance, automatically propagated
 * through the async chain started by `run()`. This is what lets
 * `@CurrentTenant()` and `TenantContextService` read the current request's
 * context from anywhere (services, guards, decorators) without threading it
 * through every function signature or relying on Nest's REQUEST-scoped DI
 * (which would instantiate a fresh provider tree per request — unnecessary
 * overhead here, and irrelevant to horizontal scalability either way: this
 * storage is per in-flight request on one process, never shared or
 * persisted, so it adds no cross-instance state).
 */
export const tenantContextStorage = new AsyncLocalStorage<RequestTenantStore>();

export function getTenantContextStore(): RequestTenantStore | undefined {
  return tenantContextStorage.getStore();
}
