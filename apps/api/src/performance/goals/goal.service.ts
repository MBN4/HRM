import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, Goal, Prisma } from '@hrm/db';
import type { CreateGoalInput, UpdateGoalProgressInput } from '@hrm/shared';

export interface GoalListFilters {
  employeeId?: string;
  departmentId?: string;
  level?: string;
  cycleId?: string;
  branchId?: string;
}

const MAX_LIST_RESULTS = 200;

/**
 * Goals/OKRs — see docs/conventions/performance.md. Cascading COMPANY ->
 * TEAM -> INDIVIDUAL is expressed purely by `parentGoalId` (a plain
 * self-relation, same pattern as `Employee.managerId`) — this service does
 * not enforce that a parent's level is "above" a child's; that policing
 * would need this schema to hardcode a level ORDER, which nothing in this
 * step's brief asks for, and would only get in the way of a tenant's own
 * cascading conventions.
 */
@Injectable()
export class GoalService {
  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManage: boolean,
    allowedBranchIds: string[] | null,
    input: CreateGoalInput,
  ): Promise<Goal> {
    let employeeId: string | null = null;
    if (input.level === 'INDIVIDUAL') {
      const owner = await this.resolveOwnerEmployee(tx, callerUserId, canManage, allowedBranchIds, input.employeeId);
      employeeId = owner.id;
    } else if (!canManage) {
      throw new ForbiddenException('performance.manage is required to create a COMPANY or TEAM goal.');
    }

    return tx.goal.create({
      data: {
        tenantId,
        level: input.level,
        employeeId,
        departmentId: input.level === 'TEAM' ? (input.departmentId ?? null) : null,
        parentGoalId: input.parentGoalId ?? null,
        cycleId: input.cycleId ?? null,
        title: input.title,
        description: input.description ?? null,
        targetValue: input.targetValue ?? null,
        unit: input.unit ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManage: boolean,
    allowedBranchIds: string[] | null,
    filters: GoalListFilters,
  ): Promise<Goal[]> {
    const where: Prisma.GoalWhereInput = {};

    if (filters.employeeId) {
      where.employeeId = filters.employeeId;
    } else if (!canManage) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      where.employeeId = own.id;
    }

    if (filters.departmentId) {
      where.departmentId = filters.departmentId;
    }
    if (filters.level) {
      where.level = filters.level as Goal['level'];
    }
    if (filters.cycleId) {
      where.cycleId = filters.cycleId;
    }

    if (canManage && (filters.branchId || allowedBranchIds)) {
      const branchWhere: Prisma.EmployeeWhereInput = filters.branchId ? { branchId: filters.branchId } : { branchId: { in: allowedBranchIds! } };
      if (filters.branchId && allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      where.employee = branchWhere;
    }

    return tx.goal.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  async updateProgress(
    tx: Prisma.TransactionClient,
    id: string,
    callerUserId: string,
    canManage: boolean,
    allowedBranchIds: string[] | null,
    input: UpdateGoalProgressInput,
  ): Promise<Goal> {
    const goal = await tx.goal.findUnique({ where: { id }, include: { employee: true } });
    if (!goal) {
      throw new NotFoundException(`Goal "${id}" was not found.`);
    }

    const isOwner = goal.employee?.userId === callerUserId;
    if (!isOwner) {
      if (!canManage) {
        throw new ForbiddenException('performance.manage is required to update another goal.');
      }
      if (goal.employee && allowedBranchIds && !allowedBranchIds.includes(goal.employee.branchId)) {
        throw new NotFoundException(`Goal "${id}" was not found.`);
      }
    }

    const currentValue = input.currentValue ?? goal.currentValue;
    const progressPercent =
      input.progressPercent ?? (goal.targetValue ? clampPercent((currentValue / goal.targetValue) * 100) : goal.progressPercent);

    return tx.goal.update({
      where: { id },
      data: {
        currentValue,
        progressPercent,
        status: input.status ?? goal.status,
      },
    });
  }

  /** `explicitEmployeeId` omitted = the caller's own linked Employee. An explicit id for someone else requires `performance.manage` and branch scoping. */
  private async resolveOwnerEmployee(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManage: boolean,
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
      if (!canManage) {
        throw new ForbiddenException('performance.manage is required to set a goal for another employee.');
      }
      if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
        throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
      }
    }
    return employee;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
