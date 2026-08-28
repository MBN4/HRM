import { BadRequestException, Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { createRosterAssignmentSchema, createShiftDefinitionSchema, CreateRosterAssignmentInput, CreateShiftDefinitionInput, PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { ShiftsService } from './shifts.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/** Shift definitions + roster assignment — see docs/conventions/attendance.md. */
@Controller('attendance')
export class ShiftsController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('shifts')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('ShiftDefinition', 'CREATE')
  async createShift(@Body(new ZodValidationPipe(createShiftDefinitionSchema)) body: CreateShiftDefinitionInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.shifts.createShift(this.tenantContext.getTx(), tenantId, body);
  }

  @Get('shifts')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async listShifts() {
    return this.shifts.listShifts(this.tenantContext.getTx());
  }

  @Post('rosters')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('RosterAssignment', 'CREATE')
  async createRosterAssignment(@Body(new ZodValidationPipe(createRosterAssignmentSchema)) body: CreateRosterAssignmentInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.shifts.createRosterAssignment(this.tenantContext.getTx(), tenantId, this.tenantContext.getBranchIds(), body);
  }

  @Get('rosters')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async listRosterForEmployee(@Query('employeeId') employeeId: string) {
    if (!employeeId) {
      throw new BadRequestException('employeeId is required.');
    }
    return this.shifts.listRosterForEmployee(this.tenantContext.getTx(), employeeId);
  }
}
