import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { AuditLogEntryDto, auditQuerySchema, AuditQueryInput, PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditQueryService } from './audit-query.service';

/**
 * The query side of the audit log — deny-by-default like every other
 * mutating/sensitive route in this codebase, gated on a NEW `audit.read`
 * permission (granted to `TENANT_ADMIN` only via `ALL_PERMISSIONS`,
 * deliberately not `HR_MANAGER` — same "ownership/security territory, not
 * HR policy" reasoning /CLAUDE.md documents for `license.manage`).
 * Tenant-scoped like every read in this codebase: `tx` is the caller's own
 * RLS-scoped transaction, so a query can never surface another tenant's
 * entries regardless of what filters are passed.
 */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  async list(@Query(new ZodValidationPipe(auditQuerySchema)) filters: AuditQueryInput): Promise<AuditLogEntryDto[]> {
    return this.query.query(this.tenantContext.getTx(), filters);
  }
}
