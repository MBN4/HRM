import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, LeaveBalance, LeaveRequest, Prisma } from '@hrm/db';
import type { CreateLeaveRequestInput } from '@hrm/shared';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { availableDays, LeaveBalanceService } from './leave-balance.service';
import { countBusinessDays } from './leave-day-calculator';
import { resolveLeavePackConfig } from './leave-country-pack.util';
import { LeaveBalanceResponseDto, LeaveRequestResponseDto } from './leave-response.dto';
import { LEAVE_REQUEST_ENTITY_TYPE } from './leave.constants';

export interface LeaveRequestListFilters {
  employeeId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  branchId?: string;
  departmentId?: string;
}

export interface LeaveScopeFilters {
  branchId?: string;
  departmentId?: string;
}

const MAX_LIST_RESULTS = 200;

/**
 * The Leave module's core business logic — see docs/conventions/leave.md.
 * Deliberately does NOT own any approval state machine: a leave request
 * starts a real 0.7 `WorkflowInstance` (`WorkflowEngineService.startInstance`)
 * and this service never approves/rejects/cancels anything itself — see
 * `LeaveWorkflowEventsListener` for the balance side-effect that reacts to
 * the workflow engine's own `workflow.approved`/`workflow.rejected`/
 * `workflow.canceled` events. Every method takes `tx`/`tenantId` explicitly,
 * the same posture `EmployeeService` (1.1) already established.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly balances: LeaveBalanceService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  /**
   * Balance check happens BEFORE the request/workflow instance is created —
   * "balance checks before submission" from this step's brief. `days` is
   * computed once here (weekends/holidays excluded per the employee's
   * branch's resolved Country Pack) and frozen on the row, the same
   * "snapshot, not re-derived later" posture `WorkflowInstance.dataSnapshot`
   * itself already takes.
   */
  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    input: CreateLeaveRequestInput,
  ): Promise<LeaveRequestResponseDto> {
    const employee = await this.resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, input.employeeId);
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account and cannot submit a leave request (the workflow engine resolves approvers relative to a real requester user).',
      );
    }

    const pack = await resolveLeavePackConfig(tx, tenantId, employee.branchId);
    const days = countBusinessDays(input.startDate, input.endDate, pack.weekendDays, pack.publicHolidays);
    if (days <= 0) {
      throw new BadRequestException('The selected date range contains no working days for this branch.');
    }

    const periodYear = input.startDate.getUTCFullYear();
    const balance = await this.balances.getOrCreateBalance(
      tx,
      tenantId,
      employee.id,
      employee.branchId,
      input.leaveType,
      periodYear,
    );
    const available = availableDays(balance);
    if (available < days) {
      throw new BadRequestException(
        `Insufficient ${input.leaveType} leave balance: requested ${days} day(s), ${available} available.`,
      );
    }

    const row = await tx.leaveRequest.create({
      data: {
        tenantId,
        employeeId: employee.id,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        days,
        reason: input.reason ?? null,
        submittedByUserId: callerUserId,
      },
    });

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: employee.userId,
      entityType: LEAVE_REQUEST_ENTITY_TYPE,
      entityId: row.id,
      dataSnapshot: {
        employeeId: employee.id,
        branchId: employee.branchId,
        departmentId: employee.departmentId,
        leaveType: input.leaveType,
        days,
        startDate: input.startDate.toISOString(),
        endDate: input.endDate.toISOString(),
      },
    });

    const updated = await tx.leaveRequest.update({ where: { id: row.id }, data: { workflowInstanceId: instance.id } });
    return toRequestDto(updated);
  }

  async findById(
    tx: Prisma.TransactionClient,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<LeaveRequestResponseDto> {
    const row = await tx.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
    if (!row) {
      throw new NotFoundException(`Leave request "${id}" was not found.`);
    }
    const isSelf = row.employee.userId === callerUserId;
    if (!isSelf) {
      if (!canManageOthers || (allowedBranchIds && !allowedBranchIds.includes(row.employee.branchId))) {
        throw new NotFoundException(`Leave request "${id}" was not found.`);
      }
    }
    return toRequestDto(row);
  }

  async list(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: LeaveRequestListFilters,
  ): Promise<LeaveRequestResponseDto[]> {
    const where: Prisma.LeaveRequestWhereInput = {};

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
      const employeeWhere: Prisma.EmployeeWhereInput = {};
      if (filters.branchId) {
        employeeWhere.branchId = filters.branchId;
      } else if (allowedBranchIds) {
        employeeWhere.branchId = { in: allowedBranchIds };
      }
      if (filters.departmentId) {
        employeeWhere.departmentId = filters.departmentId;
      }
      if (Object.keys(employeeWhere).length > 0) {
        where.employee = employeeWhere;
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.status) {
      where.status = filters.status as LeaveRequest['status'];
    }
    if (filters.from) {
      where.endDate = { gte: filters.from };
    }
    if (filters.to) {
      where.startDate = { lte: filters.to };
    }

    const rows = await tx.leaveRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
    return rows.map(toRequestDto);
  }

  async getBalances(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    employeeId: string | undefined,
    periodYear: number,
  ): Promise<LeaveBalanceResponseDto[]> {
    const employee = await this.resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, employeeId);
    const rows = await this.balances.listForEmployee(tx, employee.id, periodYear);
    return rows.map(toBalanceDto);
  }

  async adjustBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    allowedBranchIds: string[] | null,
    leaveType: LeaveBalance['leaveType'],
    periodYear: number,
    deltaDays: number,
  ): Promise<LeaveBalanceResponseDto> {
    const employee = await this.requireEmployeeInScope(tx, employeeId, allowedBranchIds);
    const balance = await this.balances.adjust(tx, tenantId, employee.id, employee.branchId, leaveType, periodYear, deltaDays);
    return toBalanceDto(balance);
  }

  async calendar(
    tx: Prisma.TransactionClient,
    allowedBranchIds: string[] | null,
    scope: LeaveScopeFilters,
    from: Date,
    to: Date,
  ) {
    this.assertBranchInScope(scope.branchId, allowedBranchIds);
    const employeeWhere = this.buildEmployeeScopeWhere(scope, allowedBranchIds);
    const rows = await tx.leaveRequest.findMany({
      where: { status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from }, employee: employeeWhere },
      include: { employee: { select: { id: true, firstName: true, lastName: true, branchId: true, departmentId: true } } },
      orderBy: { startDate: 'asc' },
      take: MAX_LIST_RESULTS,
    });
    return rows.map((row) => ({
      employeeId: row.employeeId,
      employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
      leaveType: row.leaveType,
      startDate: row.startDate.toISOString(),
      endDate: row.endDate.toISOString(),
    }));
  }

  /**
   * "Overlap/conflict detection within a team" — FLAGS overlapping
   * PENDING/APPROVED requests among different employees in scope; purely
   * informational (never blocks a submission), returned as the set of
   * requests that overlap at least one other request from a DIFFERENT
   * employee in the same scope.
   */
  async conflicts(
    tx: Prisma.TransactionClient,
    allowedBranchIds: string[] | null,
    scope: LeaveScopeFilters,
    from: Date,
    to: Date,
  ): Promise<LeaveRequestResponseDto[]> {
    this.assertBranchInScope(scope.branchId, allowedBranchIds);
    const employeeWhere = this.buildEmployeeScopeWhere(scope, allowedBranchIds);
    const rows = await tx.leaveRequest.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: to }, endDate: { gte: from }, employee: employeeWhere },
      orderBy: { startDate: 'asc' },
      take: MAX_LIST_RESULTS,
    });

    const flagged = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (a.employeeId === b.employeeId) {
          continue;
        }
        const overlaps = a.startDate <= b.endDate && b.startDate <= a.endDate;
        if (overlaps) {
          flagged.add(a.id);
          flagged.add(b.id);
        }
      }
    }
    return rows.filter((row) => flagged.has(row.id)).map(toRequestDto);
  }

  private buildEmployeeScopeWhere(scope: LeaveScopeFilters, allowedBranchIds: string[] | null): Prisma.EmployeeWhereInput {
    const where: Prisma.EmployeeWhereInput = {};
    if (scope.branchId) {
      where.branchId = scope.branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    if (scope.departmentId) {
      where.departmentId = scope.departmentId;
    }
    return where;
  }

  private assertBranchInScope(branchId: string | undefined, allowedBranchIds: string[] | null): void {
    if (branchId && allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException(`You are not permitted to view leave data for branch "${branchId}".`);
    }
  }

  private async requireEmployeeInScope(
    tx: Prisma.TransactionClient,
    employeeId: string,
    allowedBranchIds: string[] | null,
  ): Promise<Employee> {
    const employee = await tx.employee.findUnique({ where: { id: employeeId } });
    if (!employee || (allowedBranchIds && !allowedBranchIds.includes(employee.branchId))) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    return employee;
  }

  /** `employeeId` omitted = the caller's own linked Employee. An explicit `employeeId` for someone else requires `leave.approve` and branch scoping. */
  private async resolveTargetEmployee(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    explicitEmployeeId?: string,
  ): Promise<Employee> {
    if (!explicitEmployeeId) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId } });
      if (!own) {
        throw new NotFoundException('You have no employee profile.');
      }
      return own;
    }

    const employee = await tx.employee.findUnique({ where: { id: explicitEmployeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
    }
    if (employee.userId !== callerUserId) {
      if (!canManageOthers) {
        throw new ForbiddenException('leave.approve is required to act on another employee\'s leave.');
      }
      if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
        throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
      }
    }
    return employee;
  }
}

function toRequestDto(row: LeaveRequest): LeaveRequestResponseDto {
  return new LeaveRequestResponseDto({
    id: row.id,
    employeeId: row.employeeId,
    leaveType: row.leaveType,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
    days: row.days,
    reason: row.reason,
    status: row.status,
    workflowInstanceId: row.workflowInstanceId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toBalanceDto(row: LeaveBalance): LeaveBalanceResponseDto {
  return new LeaveBalanceResponseDto({
    id: row.id,
    employeeId: row.employeeId,
    leaveType: row.leaveType,
    periodYear: row.periodYear,
    entitledDays: row.entitledDays,
    accruedDays: row.accruedDays,
    carriedOverDays: row.carriedOverDays,
    usedDays: row.usedDays,
    availableDays: availableDays(row),
  });
}
