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
 * `MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD` are PLUGGABLE SEAMS — see
 * /CLAUDE.md § Conventions → Workflow engine → Approver rules. They
 * resolve today against `User.managerId` / `Branch.headUserId` /
 * `Department.headUserId` (added this step specifically to make these
 * rules resolvable at all) and, for "which branch/department is this
 * request even about", against the instance's own `dataSnapshot` first
 * and the requester's sole `UserBranch` row as a fallback — there is no
 * real Employee model yet (phase 1.1) to ask "what is this person's
 * branch/department" directly. When 1.1 lands, only the two private
 * `resolveRequesterBranchId`/`resolveRequesterDepartmentId` helpers below
 * should need to change to query real employee data — the engine, the
 * `ApproverRule` type, and every other rule kind are unaffected.
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
        const requester = await tx.user.findUnique({ where: { id: context.requesterId }, select: { managerId: true } });
        if (!requester?.managerId) {
          return [];
        }
        return this.filterActive(tx, [requester.managerId]);
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
        const departmentId = this.resolveRequesterDepartmentId(context);
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

  /** Explicit `dataSnapshot.branchId` wins (the submitting module usually knows); otherwise the requester's sole `UserBranch` row, if exactly one exists — see the class doc for why this heuristic exists. */
  private async resolveRequesterBranchId(tx: Prisma.TransactionClient, context: ApproverResolutionContext): Promise<string | null> {
    const explicit = context.dataSnapshot.branchId;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
    const userBranches = await tx.userBranch.findMany({ where: { userId: context.requesterId }, select: { branchId: true } });
    return userBranches.length === 1 ? userBranches[0].branchId : null;
  }

  /** No existing "requester's department" data source at all yet — explicit `dataSnapshot.departmentId` only. */
  private resolveRequesterDepartmentId(context: ApproverResolutionContext): string | null {
    const explicit = context.dataSnapshot.departmentId;
    return typeof explicit === 'string' && explicit.length > 0 ? explicit : null;
  }

  private async filterActive(tx: Prisma.TransactionClient, userIds: string[]): Promise<string[]> {
    const users = await tx.user.findMany({ where: { id: { in: userIds }, status: 'ACTIVE' }, select: { id: true } });
    return users.map((user) => user.id);
  }
}
