import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Put, Query, UseInterceptors } from '@nestjs/common';
import {
  effectiveWorkingHoursQuerySchema,
  PERMISSIONS,
  upsertWorkingHoursPolicySchema,
  type EffectiveWorkingHoursQuery,
  type UpsertWorkingHoursPolicyInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { WorkingHoursActor, WorkingHoursService } from './working-hours.service';

/**
 * Working-hours policy admin + resolution (step 8.1) — see
 * docs/conventions/working-hours.md. Everything except `GET /effective` needs
 * `working_hours.manage` (deny-by-default); `GET /effective` additionally lets
 * any member read their OWN effective policy (it needs only `attendance.read`).
 */
@Controller('working-hours')
export class WorkingHoursController {
  constructor(
    private readonly service: WorkingHoursService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('policies')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  list() {
    return this.service.list(this.tenantContext.getTx(), this.actor());
  }

  @Get('targets')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  targets() {
    return this.service.targets(this.tenantContext.getTx(), this.actor());
  }

  @Get('effective')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  effective(@Query(new ZodValidationPipe(effectiveWorkingHoursQuerySchema)) query: EffectiveWorkingHoursQuery) {
    return this.service.effective(
      this.tenantContext.getTx(),
      this.tenantId(),
      this.actor(),
      this.tenantContext.hasPermission(PERMISSIONS.WORKING_HOURS_MANAGE),
      query.employeeId,
      query.date ?? null,
    );
  }

  @Put('company')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  @AuditLog('WorkingHoursPolicy', 'SET_COMPANY')
  setCompany(@Body(new ZodValidationPipe(upsertWorkingHoursPolicySchema)) body: UpsertWorkingHoursPolicyInput) {
    return this.service.upsertCompany(this.tenantContext.getTx(), this.tenantId(), this.actor(), body);
  }

  @Put('teams/:departmentId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  @AuditLog('WorkingHoursPolicy', 'SET_TEAM')
  setTeam(@Param('departmentId', ParseUUIDPipe) departmentId: string, @Body(new ZodValidationPipe(upsertWorkingHoursPolicySchema)) body: UpsertWorkingHoursPolicyInput) {
    return this.service.upsertTeam(this.tenantContext.getTx(), this.tenantId(), this.actor(), departmentId, body);
  }

  @Delete('teams/:departmentId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  @AuditLog('WorkingHoursPolicy', 'REMOVE_TEAM')
  removeTeam(@Param('departmentId', ParseUUIDPipe) departmentId: string) {
    return this.service.removeTeam(this.tenantContext.getTx(), this.actor(), departmentId);
  }

  @Put('members/:employeeId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  @AuditLog('WorkingHoursPolicy', 'SET_MEMBER')
  setMember(@Param('employeeId', ParseUUIDPipe) employeeId: string, @Body(new ZodValidationPipe(upsertWorkingHoursPolicySchema)) body: UpsertWorkingHoursPolicyInput) {
    return this.service.upsertMember(this.tenantContext.getTx(), this.tenantId(), this.actor(), employeeId, body);
  }

  @Delete('members/:employeeId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.WORKING_HOURS_MANAGE)
  @AuditLog('WorkingHoursPolicy', 'REMOVE_MEMBER')
  removeMember(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.removeMember(this.tenantContext.getTx(), this.actor(), employeeId);
  }

  private actor(): WorkingHoursActor {
    const userId = this.tenantContext.userId;
    if (!userId) throw new Error('Unreachable: this controller requires authentication.');
    return { userId, branchIds: this.tenantContext.getBranchIds() };
  }

  private tenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) throw new Error('Unreachable: tenant routes always run within a resolved tenant.');
    return tenantId;
  }
}
