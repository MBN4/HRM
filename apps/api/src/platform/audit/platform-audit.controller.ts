import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { auditQuerySchema, PLATFORM_PERMISSIONS, platformAuditQuerySchema, type AuditQueryInput, type PlatformAuditQueryInput } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformAuditQueryService } from './platform-audit-query.service';

/** Cross-tenant audit read — the single most sensitive read surface in the system. See PlatformAuditQueryService's own doc comment. */
@Controller('platform/audit')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
@RequirePlatformPermissions(PLATFORM_PERMISSIONS.AUDIT_READ)
export class PlatformAuditController {
  constructor(
    private readonly query: PlatformAuditQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  platformLog(@Query(new ZodValidationPipe(platformAuditQuerySchema)) filters: PlatformAuditQueryInput) {
    return this.query.readPlatformLog(this.requireActorId(), filters);
  }

  @Get('tenant/:tenantId')
  tenantLog(@Param('tenantId') tenantId: string, @Query(new ZodValidationPipe(auditQuerySchema)) filters: AuditQueryInput) {
    return this.query.readTenantLog(this.requireActorId(), tenantId, filters);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
