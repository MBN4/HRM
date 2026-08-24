import { Controller, Get, Query } from '@nestjs/common';
import { CurrentTenant } from './current-tenant.decorator';
import { CurrentTenantContext, TenantContextService } from './tenant-context.service';

/**
 * Minimal example routes proving the tenant-resolution pipeline end to end.
 * `whoami` exercises resolution + the `@CurrentTenant()` decorator with no
 * real business data; `branches` exercises an actual tenant-scoped query
 * through the request's transaction, including a deliberately "crafted"
 * override attempt that RLS — not application code — is what blocks.
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
    // `craftedTenantId` simulates a buggy/malicious client trying to
    // override the tenant scope via a query param. RLS ignores it: the
    // transaction's app.current_tenant setting — set once, from the
    // resolved request tenant, before this handler ever ran — is what
    // actually governs which rows come back, regardless of what a WHERE
    // clause asks for.
    return tx.branch.findMany({
      where: craftedTenantId ? { tenantId: craftedTenantId } : undefined,
      select: { id: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
  }
}
