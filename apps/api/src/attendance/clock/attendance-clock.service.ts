import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AttendanceRecord, AttendanceSource, Branch, Employee, Prisma } from '@hrm/db';
import type { ClockInInput, ClockOutInput } from '@hrm/shared';
import { StorageService } from '../../storage/storage.service';
import { resolveAttendancePackConfig } from '../attendance-country-pack.util';
import { computeRecordMetrics } from '../attendance-metrics.util';
import { ALREADY_CLOCKED_IN_MESSAGE } from '../attendance.constants';
import { resolveTargetEmployee } from '../attendance-scope.util';
import { AttendanceRecordResponseDto } from '../attendance-response.dto';
import { isWithinGeofence } from '../geofence.util';
import { ShiftResolutionService } from '../shifts/shift-resolution.service';
import { AttendanceSummaryService } from '../summary/attendance-summary.service';

export interface UploadedPhoto {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface ClockListFilters {
  employeeId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
}

const MAX_LIST_RESULTS = 200;

function photoKeyFor(tenantId: string, employeeId: string, recordId: string, direction: 'in' | 'out', fileName: string): string {
  // Namespaced by tenant/employee, the SAME "bucket layout is itself
  // tenant-partitioned, defense-in-depth alongside (never instead of) RLS"
  // convention `EmployeeDocumentsService` (1.1) already established.
  return `attendance/${tenantId}/${employeeId}/${recordId}-${direction}-${fileName}`;
}

/**
 * Clock-in/out — the core of the Attendance module. See
 * docs/conventions/attendance.md for the full write-up of the day-
 * attribution algorithm this implements: `workDate` is resolved ONCE at
 * clock-in (`resolveWorkDate`, using the employee's resolved roster shift
 * and their BRANCH's timezone — never the server's) and frozen; clock-out
 * only ever closes that SAME open record, regardless of what local
 * calendar date the clock-out itself happens on. This is what makes a
 * shift crossing midnight attribute correctly to one working day.
 */
@Injectable()
export class AttendanceClockService {
  constructor(
    private readonly storage: StorageService,
    private readonly shiftResolution: ShiftResolutionService,
    private readonly summary: AttendanceSummaryService,
  ) {}

  async clockIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    input: ClockInInput,
    photo?: UploadedPhoto,
  ): Promise<AttendanceRecordResponseDto> {
    const employee = await resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, input.employeeId);
    return this.clockInForEmployee(tx, tenantId, employee, input.source, input.lat, input.long, photo);
  }

  /**
   * The lower-level entry point ALSO used by the biometric device seam
   * (`ManualBiometricDeviceAdapter`), which has already resolved a specific
   * employee from the device's own reported identifier and has no
   * "caller"/branch-scoping concept of its own — a device is trusted to
   * report punches for whichever employee it identifies.
   */
  async clockInForEmployee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Employee,
    source: AttendanceSource,
    lat?: number,
    long?: number,
    photo?: UploadedPhoto,
  ): Promise<AttendanceRecordResponseDto> {
    const open = await tx.attendanceRecord.findFirst({ where: { employeeId: employee.id, status: 'OPEN' } });
    if (open) {
      throw new BadRequestException(ALREADY_CLOCKED_IN_MESSAGE);
    }

    const branch = await tx.branch.findUniqueOrThrow({ where: { id: employee.branchId } });
    this.enforceGeofence(branch, source, lat, long);

    const now = new Date();
    const { shift, workDate } = await this.shiftResolution.resolveForClockIn(tx, employee.id, now, branch.timezone);

    const record = await tx.attendanceRecord.create({
      data: {
        tenantId,
        employeeId: employee.id,
        branchId: employee.branchId,
        workDate,
        shiftDefinitionId: shift?.id ?? null,
        clockInAt: now,
        clockInSource: source,
        clockInLat: lat ?? null,
        clockInLong: long ?? null,
        status: 'OPEN',
      },
    });

    let clockInPhotoKey: string | null = null;
    if (photo) {
      clockInPhotoKey = photoKeyFor(tenantId, employee.id, record.id, 'in', photo.fileName);
      await this.storage.uploadObject({ key: clockInPhotoKey, body: photo.buffer, contentType: photo.mimeType });
      await tx.attendanceRecord.update({
        where: { id_workDate: { id: record.id, workDate } },
        data: { clockInPhotoKey },
      });
    }

    return toRecordDto({ ...record, clockInPhotoKey });
  }

  async clockOut(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    input: ClockOutInput,
    photo?: UploadedPhoto,
  ): Promise<AttendanceRecordResponseDto> {
    const employee = await resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, input.employeeId);
    return this.clockOutForEmployee(tx, tenantId, employee, input.source, input.lat, input.long, photo);
  }

  async clockOutForEmployee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Employee,
    source: AttendanceSource,
    lat?: number,
    long?: number,
    photo?: UploadedPhoto,
  ): Promise<AttendanceRecordResponseDto> {
    const open = await tx.attendanceRecord.findFirst({ where: { employeeId: employee.id, status: 'OPEN' } });
    if (!open) {
      throw new NotFoundException('No open clock-in was found for this employee — clock in first.');
    }

    const branch = await tx.branch.findUniqueOrThrow({ where: { id: employee.branchId } });
    this.enforceGeofence(branch, source, lat, long);

    const now = new Date();
    if (now <= open.clockInAt) {
      throw new BadRequestException('Clock-out must be after clock-in.');
    }

    const shift = open.shiftDefinitionId ? await tx.shiftDefinition.findUnique({ where: { id: open.shiftDefinitionId } }) : null;
    const pack = await resolveAttendancePackConfig(tx, tenantId, employee.branchId);
    const { workedMinutes, overtimeMinutes, lateMinutes } = computeRecordMetrics({
      clockInAt: open.clockInAt,
      clockOutAt: now,
      workDate: open.workDate,
      timeZone: branch.timezone,
      shift,
      overtimeRules: pack.overtimeRules,
    });

    let clockOutPhotoKey: string | null = null;
    if (photo) {
      clockOutPhotoKey = photoKeyFor(tenantId, employee.id, open.id, 'out', photo.fileName);
      await this.storage.uploadObject({ key: clockOutPhotoKey, body: photo.buffer, contentType: photo.mimeType });
    }

    const updated = await tx.attendanceRecord.update({
      where: { id_workDate: { id: open.id, workDate: open.workDate } },
      data: {
        clockOutAt: now,
        clockOutSource: source,
        clockOutLat: lat ?? null,
        clockOutLong: long ?? null,
        clockOutPhotoKey,
        status: 'CLOSED',
        workedMinutes,
        overtimeMinutes,
        lateMinutes,
      },
    });

    // Fire-and-forget, cheap (one employee, one day) — see
    // docs/conventions/attendance.md for why heavier reports read ONLY the
    // precomputed summary table rather than aggregating AttendanceRecord.
    this.summary.enqueueRecompute(tenantId, updated.workDate, employee.branchId, employee.id).catch(() => undefined);

    return toRecordDto(updated);
  }

  async listRecords(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: ClockListFilters,
  ): Promise<AttendanceRecordResponseDto[]> {
    const where: Prisma.AttendanceRecordWhereInput = {};

    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      where.employeeId = own.id;
    } else {
      if (filters.branchId && allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      if (filters.branchId) {
        where.branchId = filters.branchId;
      } else if (allowedBranchIds) {
        where.branchId = { in: allowedBranchIds };
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.from) {
      where.workDate = { ...(where.workDate as Prisma.DateTimeFilter), gte: filters.from };
    }
    if (filters.to) {
      where.workDate = { ...(where.workDate as Prisma.DateTimeFilter), lte: filters.to };
    }

    const rows = await tx.attendanceRecord.findMany({ where, orderBy: { clockInAt: 'desc' }, take: MAX_LIST_RESULTS });
    return rows.map(toRecordDto);
  }

  async findById(
    tx: Prisma.TransactionClient,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<AttendanceRecordResponseDto> {
    const row = await tx.attendanceRecord.findFirst({ where: { id }, include: { employee: true } });
    if (!row) {
      throw new NotFoundException(`Attendance record "${id}" was not found.`);
    }
    const isSelf = row.employee.userId === callerUserId;
    if (!isSelf) {
      if (!canManageOthers || (allowedBranchIds && !allowedBranchIds.includes(row.employee.branchId))) {
        throw new NotFoundException(`Attendance record "${id}" was not found.`);
      }
    }
    return toRecordDto(row);
  }

  private enforceGeofence(branch: Branch, source: AttendanceSource, lat?: number, long?: number): void {
    // A device sitting at a fixed physical location already enforces
    // presence by construction; a self-service WEB/MOBILE clock is the one
    // case a spoofed location is a real risk (see docs/conventions/attendance.md).
    if (source !== 'WEB' && source !== 'MOBILE') {
      return;
    }
    const configured = branch.geofenceLat !== null && branch.geofenceLong !== null && branch.geofenceRadiusMeters !== null;
    if (!configured) {
      return;
    }
    if (lat === undefined || long === undefined) {
      throw new BadRequestException('This branch requires lat/long for clock-in/out (geo-fencing is enabled).');
    }
    if (!isWithinGeofence(branch, lat, long)) {
      throw new BadRequestException('Clock location is outside the allowed geo-fence for this branch.');
    }
  }
}

function toRecordDto(row: AttendanceRecord): AttendanceRecordResponseDto {
  return new AttendanceRecordResponseDto({
    id: row.id,
    employeeId: row.employeeId,
    branchId: row.branchId,
    workDate: row.workDate.toISOString(),
    shiftDefinitionId: row.shiftDefinitionId,
    clockInAt: row.clockInAt.toISOString(),
    clockInSource: row.clockInSource,
    clockInLat: row.clockInLat,
    clockInLong: row.clockInLong,
    clockOutAt: row.clockOutAt?.toISOString() ?? null,
    clockOutSource: row.clockOutSource,
    clockOutLat: row.clockOutLat,
    clockOutLong: row.clockOutLong,
    status: row.status,
    workedMinutes: row.workedMinutes,
    overtimeMinutes: row.overtimeMinutes,
    lateMinutes: row.lateMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
