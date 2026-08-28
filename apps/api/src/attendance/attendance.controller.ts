import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  branchGeofenceSchema,
  BranchGeofenceInput,
  clockInSchema,
  clockOutSchema,
  ClockInInput,
  ClockOutInput,
  manualPunchSchema,
  ManualPunchInput,
  PERMISSIONS,
  runAttendanceSummarySchema,
  RunAttendanceSummaryInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AttendanceClockService } from './clock/attendance-clock.service';
import { BIOMETRIC_DEVICE_ADAPTER, BiometricDeviceAdapter } from './devices/biometric-device.interface';
import { AttendanceSummaryService } from './summary/attendance-summary.service';

const MAX_PHOTO_SIZE_BYTES = 20 * 1024 * 1024;

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

/**
 * Clock-in/out, raw record reads, the biometric-device demo route, branch
 * geo-fence configuration, and the summary-recompute trigger — see
 * docs/conventions/attendance.md. Regularization has its own controller
 * (attendance-regularization.controller.ts) — THE RULE (workflow.md) holds:
 * no approve/reject route lives here, that's the generic 0.7 workflow
 * engine's routes.
 */
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly clock: AttendanceClockService,
    private readonly summary: AttendanceSummaryService,
    private readonly tenantContext: TenantContextService,
    @Inject(BIOMETRIC_DEVICE_ADAPTER) private readonly biometricDevice: BiometricDeviceAdapter,
  ) {}

  /**
   * Multipart (an optional selfie alongside lat/long) — the SAME "binary
   * content doesn't fit a JSON string" posture `EmployeeDocumentsController`
   * (1.1) already established for document upload.
   */
  @Post('clock-in')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('AttendanceRecord', 'CLOCK_IN')
  async clockIn(
    @Body(new ZodValidationPipe(clockInSchema)) body: ClockInInput,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.clock.clockIn(
      this.tenantContext.getTx(),
      tenantId,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      body,
      photo ? { buffer: photo.buffer, mimeType: photo.mimetype, fileName: photo.originalname } : undefined,
    );
  }

  @Post('clock-out')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('AttendanceRecord', 'CLOCK_OUT')
  async clockOut(
    @Body(new ZodValidationPipe(clockOutSchema)) body: ClockOutInput,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.clock.clockOut(
      this.tenantContext.getTx(),
      tenantId,
      this.tenantContext.userId!,
      canManageOthers,
      this.tenantContext.getBranchIds(),
      body,
      photo ? { buffer: photo.buffer, mimeType: photo.mimetype, fileName: photo.originalname } : undefined,
    );
  }

  @Get('records')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async listRecords(
    @Query('employeeId') employeeId?: string,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.clock.listRecords(this.tenantContext.getTx(), this.tenantContext.userId!, canManageOthers, this.tenantContext.getBranchIds(), {
      employeeId,
      branchId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('records/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async findRecord(@Param('id') id: string) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.clock.findById(this.tenantContext.getTx(), id, this.tenantContext.userId!, canManageOthers, this.tenantContext.getBranchIds());
  }

  /** The biometric device seam's proof surface — see devices/biometric-device.interface.ts. */
  @Post('devices/manual-punch')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('AttendanceRecord', 'DEVICE_PUNCH')
  async manualPunch(@Body(new ZodValidationPipe(manualPunchSchema)) body: ManualPunchInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.biometricDevice.handlePunch(this.tenantContext.getTx(), tenantId, {
      employeeCode: body.employeeCode,
      direction: body.direction,
      timestamp: body.timestamp,
      deviceId: body.deviceId,
    });
  }

  @Post('branches/:branchId/geofence')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  @AuditLog('Branch', 'UPDATE')
  async setGeofence(@Param('branchId') branchId: string, @Body(new ZodValidationPipe(branchGeofenceSchema)) body: BranchGeofenceInput) {
    const tx = this.tenantContext.getTx();
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { id: true } });
    if (!branch) {
      throw new BadRequestException(`Branch "${branchId}" was not found.`);
    }
    return tx.branch.update({
      where: { id: branchId },
      data: {
        geofenceLat: body.geofenceLat,
        geofenceLong: body.geofenceLong,
        geofenceRadiusMeters: body.geofenceRadiusMeters,
      },
      select: { id: true, geofenceLat: true, geofenceLong: true, geofenceRadiusMeters: true },
    });
  }

  @Post('summary/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_APPROVE)
  async runSummary(@Body(new ZodValidationPipe(runAttendanceSummarySchema)) body: RunAttendanceSummaryInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.summary.enqueueRecompute(tenantId, body.workDate, body.branchId, body.employeeId);
    return { enqueued: true };
  }

  @Get('reports/summary')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async summaryReport(
    @Query('employeeId') employeeId?: string,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.ATTENDANCE_APPROVE);
    return this.summary.report(this.tenantContext.getTx(), this.tenantContext.userId!, canManageOthers, this.tenantContext.getBranchIds(), {
      employeeId,
      branchId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }
}
