import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@hrm/db';

/**
 * Per-request tenant/user context. `branchId`, `userId`, `roles`,
 * `permissions`, and `branchIds` all stayed null until auth (0.4); they are
 * now populated by `TenantScopeInterceptor` for any authenticated request
 * (see tenant-scope.interceptor.ts). `tx` is the live Postgres transaction
 * the whole request runs in; it is null for public and platform requests,
 * which never open one.
 */
export interface RequestTenantStore {
  tenantId: string | null;
  /** The user's first allowed branch, or null if unrestricted/anonymous. Prefer `branchIds` for enforcement. */
  branchId: string | null;
  userId: string | null;
  /** Role names held by the user, e.g. `["HR_MANAGER"]`. Null until authenticated. */
  roles: string[] | null;
  /** The user's full resolved permission-key set, e.g. `["employee.read"]`. Null until authenticated. */
  permissions: string[] | null;
  /**
   * Branches the user is limited to. `null` means UNRESTRICTED (sees every
   * branch in the tenant, subject to tenant RLS as always) — this is the
   * "user has zero UserBranch rows" case, not "user can see nothing".
   */
  branchIds: string[] | null;
  /** True only for requests through an explicit @PlatformRoute() — see platform-route.decorator.ts. */
  platform: boolean;
  /**
   * Step 4.1 — the authenticated platform admin's own id/role, populated
   * by `TenantScopeInterceptor` for any `@PlatformRoute()` request that
   * isn't `@AllowAnonymousPlatform()`. Both null for a normal tenant
   * request, AND for an `@AllowAnonymousPlatform()` one (login/MFA/
   * refresh — there's no authenticated admin yet).
   */
  platformAdminId: string | null;
  platformRole: string | null;
  /**
   * Step 4.1 — set ONLY for a normal tenant request authenticated via an
   * impersonation access token: the REAL platform admin's id, kept
   * alongside `userId` (the impersonated tenant user) so every audited
   * mutation during the session is tagged with who was really acting —
   * see docs/conventions/vendor-console.md → Impersonation. Null for
   * every other request, platform or tenant.
   */
  impersonatedByPlatformAdminId: string | null;
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
