import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  adjustLeaveBalanceSchema,
  AdjustLeaveBalanceInput,
  AUDIT_ACTIONS,
  createLeaveRequestSchema,
  CreateLeaveRequestInput,
  LEAVE_REQUEST_STATUSES,
  PERMISSIONS,
  runLeaveAccrualSchema,
  RunLeaveAccrualInput,
} from '@hrm/shared';
import type { LeaveType } from '@hrm/db';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { LeaveAccrualService } from './accrual/leave-accrual.service';
import { LeaveService } from './leave.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date.`);
  }
  return date;
}

function requireDate(value: string | undefined, field: string): Date {
  const date = parseDate(value, field);
  if (!date) {
    throw new BadRequestException(`${field} is required.`);
  }
  return date;
}

/**
 * The Leave module's HTTP surface — see docs/conventions/leave.md. Every
 * mutating route is deny-by-default; note there is DELIBERATELY no
 * approve/reject/cancel route here — those are the generic 0.7 workflow
 * engine's `POST /workflow/instances/:id/steps/:stepId/actions` and
 * `POST /workflow/instances/:id/cancel`, using the `workflowInstanceId`
 * returned on `GET /leave/requests/:id` — THE RULE (see
 * docs/conventions/workflow.md) applied for real by this module.
 */
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly accrual: LeaveAccrualService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('requests')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LEAVE_WRITE)
  @AuditLog('LeaveRequest', AUDIT_ACTIONS.CREATE)
  async submit(@Body(new ZodValidationPipe(createLeaveRequestSchema)) body: CreateLeaveRequestInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.LEAVE_APPROVE);
    return this.leave.submit(
      this.tenantContext.getTx(),
      tenantId,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      body,
    );
  }

  @Get('requests')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_READ)
  async list(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (status && !(LEAVE_REQUEST_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${LEAVE_REQUEST_STATUSES.join(', ')}.`);
    }
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.LEAVE_APPROVE);
    return this.leave.list(this.tenantContext.getTx(), this.tenantContext.userId!, canManageOthers, this.tenantContext.getBranchIds(), {
      employeeId,
      status,
      branchId,
      departmentId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('balances')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_READ)
  async balances(@Query('employeeId') employeeId?: string, @Query('year') year?: string) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.LEAVE_APPROVE);
    const periodYear = year ? Number(year) : new Date().getUTCFullYear();
    return this.leave.getBalances(
      this.tenantContext.getTx(),
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      employeeId,
      periodYear,
    );
  }

  @Post('balances/:employeeId/adjust')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LEAVE_APPROVE)
  @AuditLog('LeaveBalance', AUDIT_ACTIONS.UPDATE)
  async adjustBalance(
    @Param('employeeId') employeeId: string,
    @Body(new ZodValidationPipe(adjustLeaveBalanceSchema)) body: AdjustLeaveBalanceInput,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const periodYear = body.periodYear ?? new Date().getUTCFullYear();
    return this.leave.adjustBalance(
      this.tenantContext.getTx(),
      tenantId,
      employeeId,
      this.tenantContext.getBranchIds(),
      body.leaveType as LeaveType,
      periodYear,
      body.deltaDays,
    );
  }

  @Get('calendar')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_READ)
  async calendar(
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.leave.calendar(
      this.tenantContext.getTx(),
      this.tenantContext.getBranchIds(),
      { branchId, departmentId },
      requireDate(from, 'from'),
      requireDate(to, 'to'),
    );
  }

  @Get('conflicts')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_READ)
  async conflicts(
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.leave.conflicts(
      this.tenantContext.getTx(),
      this.tenantContext.getBranchIds(),
      { branchId, departmentId },
      requireDate(from, 'from'),
      requireDate(to, 'to'),
    );
  }

  @Post('accrual/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_APPROVE)
  async runAccrual(@Body(new ZodValidationPipe(runLeaveAccrualSchema)) body: RunLeaveAccrualInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.accrual.enqueueRun(tenantId, body.periodYear, body.periodMonth);
    return { enqueued: true };
  }

  @Get('requests/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LEAVE_READ)
  async findOne(@Param('id') id: string) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.LEAVE_APPROVE);
    return this.leave.findById(
      this.tenantContext.getTx(),
      id,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
    );
  }
}
