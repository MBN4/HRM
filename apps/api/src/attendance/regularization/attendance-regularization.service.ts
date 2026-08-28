import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AttendanceRegularization, Prisma } from '@hrm/db';
import type { CreateRegularizationInput } from '@hrm/shared';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { resolveTargetEmployee } from '../attendance-scope.util';
import { AttendanceRegularizationResponseDto } from '../attendance-response.dto';
import { ATTENDANCE_REGULARIZATION_ENTITY_TYPE } from '../attendance.constants';

export interface RegularizationListFilters {
  employeeId?: string;
  status?: string;
}

const MAX_LIST_RESULTS = 200;

/**
 * A missed/incorrect punch correction ("regularization") — THE RULE applied
 * for real, exactly like `LeaveService` (1.2): this service creates the
 * `AttendanceRegularization` row, then hands off completely to the real 0.7
 * `WorkflowEngineService`. There is DELIBERATELY no approve/reject route
 * anywhere in this module — see `AttendanceRegularizationController`.
 * `AttendanceRegularizationWorkflowEventsListener` reacts to the engine's
 * own `workflow.approved`/`workflow.rejected`/`workflow.canceled` events to
 * apply the one side-effect the generic engine has no way to know about:
 * mutating the actual `AttendanceRecord`.
 */
@Injectable()
export class AttendanceRegularizationService {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    input: CreateRegularizationInput,
  ): Promise<AttendanceRegularizationResponseDto> {
    const employee = await resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, input.employeeId);
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account and cannot submit a regularization (the workflow engine resolves approvers relative to a real requester user).',
      );
    }

    if (input.attendanceRecordId) {
      const record = await tx.attendanceRecord.findFirst({ where: { id: input.attendanceRecordId, employeeId: employee.id } });
      if (!record) {
        throw new NotFoundException(`Attendance record "${input.attendanceRecordId}" was not found for this employee.`);
      }
    } else if (!input.requestedClockInAt) {
      // No existing record to patch means a brand-new one must be creatable
      // on approval, which needs at least a clock-in — see
      // AttendanceRegularizationWorkflowEventsListener.
      throw new BadRequestException('requestedClockInAt is required when attendanceRecordId is omitted (a fully missing punch).');
    }

    const row = await tx.attendanceRegularization.create({
      data: {
        tenantId,
        employeeId: employee.id,
        attendanceRecordId: input.attendanceRecordId ?? null,
        workDate: input.workDate,
        requestedClockInAt: input.requestedClockInAt ?? null,
        requestedClockOutAt: input.requestedClockOutAt ?? null,
        reason: input.reason,
        submittedByUserId: callerUserId,
      },
    });

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: employee.userId,
      entityType: ATTENDANCE_REGULARIZATION_ENTITY_TYPE,
      entityId: row.id,
      dataSnapshot: {
        employeeId: employee.id,
        branchId: employee.branchId,
        departmentId: employee.departmentId,
        workDate: input.workDate.toISOString(),
        attendanceRecordId: input.attendanceRecordId ?? null,
      },
    });

    const updated = await tx.attendanceRegularization.update({ where: { id: row.id }, data: { workflowInstanceId: instance.id } });
    return toDto(updated);
  }

  async findById(
    tx: Prisma.TransactionClient,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<AttendanceRegularizationResponseDto> {
    const row = await tx.attendanceRegularization.findUnique({ where: { id }, include: { employee: true } });
    if (!row) {
      throw new NotFoundException(`Regularization "${id}" was not found.`);
    }
    const isSelf = row.employee.userId === callerUserId;
    if (!isSelf) {
      if (!canManageOthers || (allowedBranchIds && !allowedBranchIds.includes(row.employee.branchId))) {
        throw new NotFoundException(`Regularization "${id}" was not found.`);
      }
    }
    return toDto(row);
  }

  async list(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: RegularizationListFilters,
  ): Promise<AttendanceRegularizationResponseDto[]> {
    const where: Prisma.AttendanceRegularizationWhereInput = {};

    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      where.employeeId = own.id;
    } else {
      const employeeWhere: Prisma.EmployeeWhereInput = {};
      if (allowedBranchIds) {
        employeeWhere.branchId = { in: allowedBranchIds };
      }
      if (Object.keys(employeeWhere).length > 0) {
        where.employee = employeeWhere;
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.status) {
      where.status = filters.status as AttendanceRegularization['status'];
    }

    const rows = await tx.attendanceRegularization.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
    return rows.map(toDto);
  }
}

function toDto(row: AttendanceRegularization): AttendanceRegularizationResponseDto {
  return new AttendanceRegularizationResponseDto({
    id: row.id,
    employeeId: row.employeeId,
    attendanceRecordId: row.attendanceRecordId,
    workDate: row.workDate.toISOString(),
    requestedClockInAt: row.requestedClockInAt?.toISOString() ?? null,
    requestedClockOutAt: row.requestedClockOutAt?.toISOString() ?? null,
    reason: row.reason,
    status: row.status,
    workflowInstanceId: row.workflowInstanceId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
