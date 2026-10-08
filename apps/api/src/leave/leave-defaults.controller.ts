import { BadRequestException, Body, Controller, Get, Param, Put, UseInterceptors } from '@nestjs/common';
import { AUDIT_ACTIONS, PERMISSIONS, updateLeaveDefaultsSchema, UpdateLeaveDefaultsInput } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditCaptureService } from '../audit/audit-capture.service';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { CountryPackResolutionService } from '../country-packs/country-pack-resolution.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { LeaveDefaultsService } from './leave-defaults.service';

/**
 * Step 8.1 Part 4 — the admin "default leave allocation" surface (docs/conventions/leave.md § Default leave
 * allocation). Both routes need `leave.defaults.manage` (HR_MANAGER / CEO / TENANT_ADMIN); a plain member or
 * manager gets 403. Writes are audited (before = the previous override row).
 */
@Controller('leave/defaults')
export class LeaveDefaultsController {
  constructor(
    private readonly defaults: LeaveDefaultsService,
    private readonly tenantContext: TenantContextService,
    private readonly auditCapture: AuditCaptureService,
    private readonly packResolution: CountryPackResolutionService,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.tenantId;
    if (!id) throw new BadRequestException('No tenant context is bound to this request.');
    return id;
  }

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_DEFAULTS_MANAGE)
  list() {
    return this.defaults.list(this.tenantContext.getTx(), this.tenantId());
  }

  @Put(':countryCode')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LEAVE_DEFAULTS_MANAGE)
  @AuditLog('LeaveDefaults', AUDIT_ACTIONS.UPDATE)
  async update(@Param('countryCode') countryCode: string, @Body(new ZodValidationPipe(updateLeaveDefaultsSchema)) body: UpdateLeaveDefaultsInput) {
    const tenantId = this.tenantId();
    const code = this.defaults.requireCountry(countryCode);
    const result = await this.defaults.update(this.tenantContext.getTx(), tenantId, code, body, (b) => this.auditCapture.setBefore(b));
    await this.packResolution.invalidateForTenant(tenantId, code); // the 5.1 cached effective config is now stale
    return result;
  }
}
