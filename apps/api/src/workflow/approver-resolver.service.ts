import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { ApproverRule } from '@hrm/shared';
import { evaluateWorkflowCondition } from './condition-evaluator';

export interface ApproverResolutionContext {
  requesterId: string;
  dataSnapshot: Record<string, unknown>;
}

/**
 * Resolves an `ApproverRule` into the set of user ids currently eligible
 * to act — a strategy per rule kind, all queried through the caller's
 * tenant-scoped transaction (RLS-enforced, same as every other tenant-
 * aware service). Only `ACTIVE` users are ever returned.
 *
 * `MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD` were PLUGGABLE SEAMS as of 0.7
 * — see docs/conventions/workflow.md → Approver rules. As of step 1.1 (the
 * real Employee module, see docs/conventions/employee.md), they now resolve
 * PRIMARILY against the real org chart (`Employee.managerId`/`branchId`/
 * `departmentId`), falling back to the legacy 0.7 seams
 * (`User.managerId`/the requester's sole `UserBranch` row) only for a
 * requester with NO `Employee` record at all (e.g. an admin-only account
 * never onboarded as an employee) — this is exactly the change 0.7's own
 * doc comment predicted: "only the two private
 * `resolveRequesterBranchId`/`resolveRequesterDepartmentId` helpers [plus,
 * as it turned out, the `MANAGER` case itself] should need to change to
 * query real employee data — the engine, the `ApproverRule` type, and
 * every other rule kind are unaffected."
 */
@Injectable()
export class ApproverResolverService {
  async resolve(tx: Prisma.TransactionClient, rule: ApproverRule, context: ApproverResolutionContext): Promise<string[]> {
    switch (rule.type) {
      case 'SPECIFIC_USER':
        return this.filterActive(tx, [rule.userId]);

      case 'ROLE': {
        const role = await tx.role.findFirst({ where: { name: rule.roleName }, select: { id: true } });
        if (!role) {
          return [];
        }
        const userRoles = await tx.userRole.findMany({
          where: { roleId: role.id, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        return [...new Set(userRoles.map((userRole) => userRole.userId))];
      }

      case 'MANAGER': {
        const managerUserId = await this.resolveRequesterManagerUserId(tx, context.requesterId);
        if (!managerUserId) {
          return [];
        }
        return this.filterActive(tx, [managerUserId]);
      }

      case 'BRANCH_HEAD': {
        const branchId = await this.resolveRequesterBranchId(tx, context);
        if (!branchId) {
          return [];
        }
        const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { headUserId: true } });
        if (!branch?.headUserId) {
          return [];
        }
        return this.filterActive(tx, [branch.headUserId]);
      }

      case 'DEPARTMENT_HEAD': {
        const departmentId = await this.resolveRequesterDepartmentId(tx, context);
        if (!departmentId) {
          return [];
        }
        const department = await tx.department.findUnique({ where: { id: departmentId }, select: { headUserId: true } });
        if (!department?.headUserId) {
          return [];
        }
        return this.filterActive(tx, [department.headUserId]);
      }

      case 'CONDITIONAL': {
        const matches = evaluateWorkflowCondition(rule.condition, context.dataSnapshot);
        return this.resolve(tx, matches ? rule.ifTrue : rule.ifFalse, context);
      }
    }
  }

  /**
   * Prefers the real Employee org chart (`Employee.managerId`, resolved to
   * that manager's linked `User` account) — the seam this rule was always
   * meant to resolve against once the Employee module (1.1) landed, see
   * docs/conventions/employee.md. Falls back to the legacy `User.managerId`
   * seam column (0.7) for a requester with no `Employee` record at all, so
   * nothing that worked before 1.1 regresses.
   */
  private async resolveRequesterManagerUserId(tx: Prisma.TransactionClient, requesterId: string): Promise<string | null> {
    const employee = await tx.employee.findFirst({ where: { userId: requesterId }, select: { managerId: true } });
    if (employee) {
      if (!employee.managerId) {
        return null;
      }
      const manager = await tx.employee.findUnique({ where: { id: employee.managerId }, select: { userId: true } });
      return manager?.userId ?? null;
    }
    const requester = await tx.user.findUnique({ where: { id: requesterId }, select: { managerId: true } });
    return requester?.managerId ?? null;
  }

  /**
   * Explicit `dataSnapshot.branchId` wins (the submitting module usually
   * knows); otherwise the requester's `Employee.branchId`, if they have an
   * Employee record; otherwise the requester's sole `UserBranch` row, if
   * exactly one exists — the original 0.7 heuristic, kept as a last-resort
   * fallback for a requester with no Employee record.
   */
  private async resolveRequesterBranchId(tx: Prisma.TransactionClient, context: ApproverResolutionContext): Promise<string | null> {
    const explicit = context.dataSnapshot.branchId;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
    const employee = await tx.employee.findFirst({ where: { userId: context.requesterId }, select: { branchId: true } });
    if (employee?.branchId) {
      return employee.branchId;
    }
    const userBranches = await tx.userBranch.findMany({ where: { userId: context.requesterId }, select: { branchId: true } });
    return userBranches.length === 1 ? userBranches[0].branchId : null;
  }

  /**
   * Explicit `dataSnapshot.departmentId` wins; otherwise the requester's
   * `Employee.departmentId` — the real fallback 0.7's own doc comment noted
   * DEPARTMENT_HEAD had no equivalent of (there was no "requester's
   * department" data source at all before the Employee module existed).
   */
  private async resolveRequesterDepartmentId(tx: Prisma.TransactionClient, context: ApproverResolutionContext): Promise<string | null> {
    const explicit = context.dataSnapshot.departmentId;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
    const employee = await tx.employee.findFirst({ where: { userId: context.requesterId }, select: { departmentId: true } });
    return employee?.departmentId ?? null;
  }

  private async filterActive(tx: Prisma.TransactionClient, userIds: string[]): Promise<string[]> {
    const users = await tx.user.findMany({ where: { id: { in: userIds }, status: 'ACTIVE' }, select: { id: true } });
    return users.map((user) => user.id);
  }
}
