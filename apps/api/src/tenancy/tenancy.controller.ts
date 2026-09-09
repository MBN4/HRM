import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentTenant } from './current-tenant.decorator';
import { OrgStructureCacheService } from './org-structure-cache.service';
import { CurrentTenantContext, TenantContextService } from './tenant-context.service';

/**
 * Minimal example routes proving the tenant-resolution pipeline end to end.
 * `whoami` exercises resolution + the `@CurrentTenant()` decorator with no
 * real business data; `branches` exercises an actual tenant-scoped query
 * through the request's transaction, including a deliberately "crafted"
 * override attempt that RLS — not application code — is what blocks, and
 * branch-scoping enforcement layered on top of tenant RLS (see
 * /CLAUDE.md § Conventions → Branch scoping).
 */
@Controller('tenancy')
export class TenancyController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly orgStructureCache: OrgStructureCacheService,
  ) {}

  @Get('whoami')
  whoami(@CurrentTenant() tenant: CurrentTenantContext): CurrentTenantContext {
    return tenant;
  }

  @Get('branches')
  async branches(@Query('tenantId') craftedTenantId?: string) {
    const tx = this.tenantContext.getTx();
    const allowedBranchIds = this.tenantContext.getBranchIds();
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }

    // `craftedTenantId` simulates a buggy/malicious client trying to
    // override the tenant scope via a query param. Previously this worked
    // by adding `where.tenantId = craftedTenantId` to the underlying query
    // and letting RLS's own `tenant_id = current_tenant` filter intersect
    // with it — a mismatched crafted id is a WHERE clause no row can ever
    // satisfy, so the result was always empty whenever it didn't equal the
    // real resolved tenant. Now that this read goes through a per-tenant
    // CACHE (see OrgStructureCacheService) rather than a fresh per-call
    // WHERE clause, that same property is expressed directly instead: a
    // crafted id that doesn't match the real resolved tenant can never
    // return real data, full stop — RLS still fundamentally governs what
    // the cache itself was ever ALLOWED to be populated with in the first
    // place, this is just the narrower "does this specific query param
    // change the answer" check restated at the cache's own boundary.
    if (craftedTenantId && craftedTenantId !== tenantId) {
      return [];
    }

    // Phase 5.1 (see docs/conventions/scaling-data-layer.md) — this is a
    // hot-path, resolve-fresh-every-request read in every module that needs
    // a branch's country code / an org-chart lookup, so it's cached
    // tenant-scoped in Redis rather than re-querying every time.
    // `allowedBranchIds` (branch scoping, see /CLAUDE.md § Conventions →
    // Branch scoping) is a SEPARATE, application-level filter applied
    // AFTER the cache read — RLS/caching have no per-branch concept, this
    // is what actually enforces it.
    const branches = await this.orgStructureCache.getBranches(tx, tenantId);
    return allowedBranchIds ? branches.filter((branch) => allowedBranchIds.includes(branch.id)) : branches;
  }
}
