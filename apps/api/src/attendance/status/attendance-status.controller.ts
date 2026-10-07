import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { attendanceStatusQuerySchema, PERMISSIONS, type AttendanceStatusQuery } from '@hrm/shared';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AttendanceStatusService } from './attendance-status.service';

/**
 * `GET /attendance/status?employeeId&from&to` (step 8.1, Part 2) — the
 * classified (GREEN / YELLOW / RED / NEUTRAL / IN_PROGRESS) days of a member
 * over a range. Read-only, computed on read; see
 * docs/conventions/attendance-status.md for the rules and Part 3's call shape.
 */
@Controller('attendance')
export class AttendanceStatusController {
  constructor(
    private readonly status: AttendanceStatusService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('status')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  classify(@Query(new ZodValidationPipe(attendanceStatusQuerySchema)) query: AttendanceStatusQuery) {
    const tenantId = this.tenantContext.tenantId;
    const userId = this.tenantContext.userId;
    if (!tenantId || !userId) throw new Error('Unreachable: tenant routes always run within a resolved, authenticated tenant.');
    return this.status.classifyRange(this.tenantContext.getTx(), tenantId, {
      userId,
      branchIds: this.tenantContext.getBranchIds(),
      canReadTenant: this.tenantContext.hasPermission(PERMISSIONS.WORKING_HOURS_MANAGE),
      canReadReports: this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE),
    }, query);
  }
}
