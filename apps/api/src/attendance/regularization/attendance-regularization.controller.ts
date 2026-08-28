import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ATTENDANCE_REGULARIZATION_STATUSES,
  createRegularizationSchema,
  CreateRegularizationInput,
  PERMISSIONS,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AttendanceRegularizationService } from './attendance-regularization.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * A missed/incorrect punch correction — see docs/conventions/attendance.md.
 * DELIBERATELY no approve/reject/cancel route here — see THE RULE
 * (docs/conventions/workflow.md): those are the generic 0.7 workflow
 * engine's `POST /workflow/instances/:id/steps/:stepId/actions` and
 * `POST /workflow/instances/:id/cancel`, using the `workflowInstanceId`
 * returned on `GET /attendance/regularizations/:id`.
 */
@Controller('attendance/regularizations')
export class AttendanceRegularizationController {
  constructor(
    private readonly regularizations: AttendanceRegularizationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post()
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_REGULARIZE)
  @AuditLog('AttendanceRegularization', AUDIT_ACTIONS.CREATE)
  async submit(@Body(new ZodValidationPipe(createRegularizationSchema)) body: CreateRegularizationInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.regularizations.submit(
      this.tenantContext.getTx(),
      tenantId,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      body,
    );
  }

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async list(@Query('employeeId') employeeId?: string, @Query('status') status?: string) {
    if (status && !(ATTENDANCE_REGULARIZATION_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${ATTENDANCE_REGULARIZATION_STATUSES.join(', ')}.`);
    }
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.regularizations.list(
      this.tenantContext.getTx(),
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      { employeeId, status },
    );
  }

  @Get(':id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async findOne(@Param('id') id: string) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.regularizations.findById(
      this.tenantContext.getTx(),
      id,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
    );
  }
}
