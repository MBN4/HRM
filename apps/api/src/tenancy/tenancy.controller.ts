import { Controller, Get, Query } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { CurrentTenant } from './current-tenant.decorator';
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
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('whoami')
  whoami(@CurrentTenant() tenant: CurrentTenantContext): CurrentTenantContext {
    return tenant;
  }

  @Get('branches')
  async branches(@Query('tenantId') craftedTenantId?: string) {
    const tx = this.tenantContext.getTx();
    const allowedBranchIds = this.tenantContext.getBranchIds();

    // `craftedTenantId` simulates a buggy/malicious client trying to
    // override the tenant scope via a query param. RLS ignores it: the
    // transaction's app.current_tenant setting — set once, from the
    // resolved request tenant, before this handler ever ran — is what
    // actually governs which rows come back, regardless of what a WHERE
    // clause asks for.
    //
    // `allowedBranchIds` is a SEPARATE, application-level filter on top of
    // that: null means the user isn't branch-limited (every branch in the
    // tenant, as usual); a non-null list narrows the result to just those
    // branches. RLS has no per-branch concept — this is what actually
    // enforces branch scoping.
    const where: Prisma.BranchWhereInput = {};
    if (craftedTenantId) {
      where.tenantId = craftedTenantId;
    }
    if (allowedBranchIds) {
      where.id = { in: allowedBranchIds };
    }

    return tx.branch.findMany({
      where,
      select: { id: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
  }
}
