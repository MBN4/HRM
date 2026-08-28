import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Employee, Prisma } from '@hrm/db';

export interface AttendanceScopeFilters {
  branchId?: string;
  departmentId?: string;
}

/**
 * The SAME "resolve who this request is actually about" shape
 * `LeaveService`'s private helpers already established (1.2) — duplicated
 * here rather than imported (those are private methods on `LeaveService`,
 * not a shared export), the same "reuse the PATTERN, not the file" posture
 * `leave-country-pack.util.ts`/`employee-country-pack.util.ts` already take
 * with each other. `employeeId` omitted = the caller's own linked
 * `Employee`. An explicit `employeeId` for someone else requires
 * `attendance.approve` and branch scoping.
 */
export async function resolveTargetEmployee(
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
      throw new ForbiddenException('attendance.approve is required to act on another employee\'s attendance.');
    }
    if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
      throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
    }
  }
  return employee;
}

export async function requireEmployeeInScope(
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

export function assertBranchInScope(branchId: string | undefined, allowedBranchIds: string[] | null): void {
  if (branchId && allowedBranchIds && !allowedBranchIds.includes(branchId)) {
    throw new ForbiddenException(`You are not permitted to view attendance data for branch "${branchId}".`);
  }
}

export function buildEmployeeScopeWhere(scope: AttendanceScopeFilters, allowedBranchIds: string[] | null): Prisma.EmployeeWhereInput {
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
