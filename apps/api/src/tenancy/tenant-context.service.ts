import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { getTenantContextStore, tenantContextStorage, RequestTenantStore } from './tenant-context.store';

export type CurrentTenantContext = Omit<RequestTenantStore, 'tx'>;

/**
 * DI-friendly accessor for the current request's tenant/auth context.
 * Backed by `tenantContextStorage` (see tenant-context.store.ts) — this
 * class holds no state of its own, so it's a completely ordinary singleton
 * provider despite every method returning per-request data.
 *
 * Only `TenantScopeInterceptor` should ever call `run()`. Everything else
 * (services, controllers, the `@CurrentTenant()` decorator) should only
 * read.
 */
@Injectable()
export class TenantContextService {
  run<T>(store: RequestTenantStore, fn: () => T): T {
    return tenantContextStorage.run(store, fn);
  }

  /** The raw store, or undefined if called outside any request's context. */
  getStore(): RequestTenantStore | undefined {
    return getTenantContextStore();
  }

  /** `{ tenantId, branchId, userId, roles, permissions, branchIds, platform }` — what `@CurrentTenant()` hands to controllers. */
  getContext(): CurrentTenantContext {
    const { tenantId, branchId, userId, roles, permissions, branchIds, platform } = this.requireStore();
    return { tenantId, branchId, userId, roles, permissions, branchIds, platform };
  }

  get tenantId(): string | null {
    return this.getStore()?.tenantId ?? null;
  }

  get userId(): string | null {
    return this.getStore()?.userId ?? null;
  }

  get isPlatform(): boolean {
    return this.getStore()?.platform ?? false;
  }

  getPermissions(): string[] {
    return this.getStore()?.permissions ?? [];
  }

  hasPermission(permission: string): boolean {
    return this.getPermissions().includes(permission);
  }

  /** null = unrestricted (sees every branch in the tenant). */
  getBranchIds(): string[] | null {
    return this.getStore()?.branchIds ?? null;
  }

  /**
   * The live transaction for this request — the only Prisma client request
   * handling code should ever query through, so RLS stays in effect for the
   * whole request. Throws for public routes (no tenant, no transaction) and
   * for platform routes (no bypass exists yet — see platform-route.decorator.ts).
   */
  getTx(): Prisma.TransactionClient {
    const store = this.requireStore();
    if (!store.tx) {
      throw new Error(
        store.platform
          ? 'No database access is available from a platform-context route yet ' +
            '(no tenant-scoped bypass exists — see /CLAUDE.md § Conventions → Platform context).'
          : 'No tenant transaction is open for this request. This route is ' +
            'either @Public() or TenantScopeInterceptor is not wired up.',
      );
    }
    return store.tx;
  }

  private requireStore(): RequestTenantStore {
    const store = this.getStore();
    if (!store) {
      throw new Error(
        'No request tenant context is active. TenantContextService can only ' +
          'be used within an HTTP request handled by TenantScopeInterceptor.',
      );
    }
    return store;
  }
}
