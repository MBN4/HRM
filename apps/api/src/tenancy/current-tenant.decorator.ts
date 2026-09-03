import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { getTenantContextStore } from './tenant-context.store';
import type { CurrentTenantContext } from './tenant-context.service';

/**
 * `{ tenantId, branchId, userId, roles, permissions, branchIds, platform }`
 * for the current request. `branchId`/`userId`/`roles`/`permissions`/
 * `branchIds` are null until the request is authenticated (0.4's
 * `TenantScopeInterceptor` populates them from the JWT + a DB lookup).
 * Reads straight from the AsyncLocalStorage store (see
 * tenant-context.store.ts) rather than through Nest's DI, which is the
 * standard way custom param decorators access request-scoped data.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): CurrentTenantContext => {
    const store = getTenantContextStore();
    if (!store) {
      throw new Error(
        'No request tenant context is active — @CurrentTenant() was used on ' +
          'a route not covered by TenantScopeInterceptor.',
      );
    }
    const {
      tenantId,
      branchId,
      userId,
      roles,
      permissions,
      branchIds,
      platform,
      platformAdminId,
      platformRole,
      impersonatedByPlatformAdminId,
    } = store;
    return {
      tenantId,
      branchId,
      userId,
      roles,
      permissions,
      branchIds,
      platform,
      platformAdminId,
      platformRole,
      impersonatedByPlatformAdminId,
    };
  },
);
