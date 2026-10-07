import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { ApproverRule } from '@hrm/shared';
import { ChainRouting, DbChainReader, isHrExcluded, resolveChainApprovers } from './approval-chain';
import { evaluateWorkflowCondition } from './condition-evaluator';

export interface ApproverResolutionContext {
  requesterId: string;
  dataSnapshot: Record<string, unknown>;
}

export interface ResolvedApprovers {
  approverIds: string[];
  /** Set only when a hierarchical (`MANAGER`) rule produced the result — WHY these approvers. */
  routing: ChainRouting | null;
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
    return (await this.resolveDetailed(tx, rule, context)).approverIds;
  }

  /**
   * Same as `resolve`, plus the chain routing (step 7.2) that explains a
   * `MANAGER` result. EVERY rule kind passes through the two hard filters:
   * the requester is never their own approver, and HR-excluded users (HR
   * administers, it does not authorize) never appear — even when a `ROLE`
   * rule names `HR_MANAGER` directly.
   */
  async resolveDetailed(tx: Prisma.TransactionClient, rule: ApproverRule, context: ApproverResolutionContext): Promise<ResolvedApprovers> {
    const raw = await this.resolveRule(tx, rule, context);
    const approverIds = await this.dropIneligible(tx, raw.approverIds, context.requesterId);
    return { approverIds, routing: raw.routing };
  }

  private async dropIneligible(tx: Prisma.TransactionClient, userIds: string[], requesterId: string): Promise<string[]> {
    const candidates = userIds.filter((id) => id !== requesterId);
    if (candidates.length === 0) {
      return [];
    }
    const users = await tx.user.findMany({
      where: { id: { in: candidates } },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });
    const excluded = new Set(users.filter((u) => isHrExcluded(u.roles.map((r) => r.role.name))).map((u) => u.id));
    return candidates.filter((id) => !excluded.has(id));
  }

  private async resolveRule(tx: Prisma.TransactionClient, rule: ApproverRule, context: ApproverResolutionContext): Promise<ResolvedApprovers> {
    const plain = async (ids: Promise<string[]>): Promise<ResolvedApprovers> => ({ approverIds: await ids, routing: null });
    switch (rule.type) {
      case 'SPECIFIC_USER':
        return plain(this.filterActive(tx, [rule.userId]));

      case 'ROLE': {
        const role = await tx.role.findFirst({ where: { name: rule.roleName }, select: { id: true } });
        if (!role) {
          return { approverIds: [], routing: null };
        }
        const userRoles = await tx.userRole.findMany({
          where: { roleId: role.id, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        return { approverIds: [...new Set(userRoles.map((userRole) => userRole.userId))], routing: null };
      }

      case 'MANAGER': {
        // Step 7.2: the hierarchical chain — direct manager, escalating up past
        // anyone unavailable, ultimately the CEO. See approval-chain.ts.
        return resolveChainApprovers(new DbChainReader(tx), context.requesterId);
      }

      case 'BRANCH_HEAD': {
        const branchId = await this.resolveRequesterBranchId(tx, context);
        if (!branchId) {
          return { approverIds: [], routing: null };
        }
        const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { headUserId: true } });
        if (!branch?.headUserId) {
          return { approverIds: [], routing: null };
        }
        return plain(this.filterActive(tx, [branch.headUserId]));
      }

      case 'DEPARTMENT_HEAD': {
        const departmentId = await this.resolveRequesterDepartmentId(tx, context);
        if (!departmentId) {
          return { approverIds: [], routing: null };
        }
        const department = await tx.department.findUnique({ where: { id: departmentId }, select: { headUserId: true } });
        if (!department?.headUserId) {
          return { approverIds: [], routing: null };
        }
        return plain(this.filterActive(tx, [department.headUserId]));
      }

      case 'CONDITIONAL': {
        const matches = evaluateWorkflowCondition(rule.condition, context.dataSnapshot);
        return this.resolveRule(tx, matches ? rule.ifTrue : rule.ifFalse, context);
      }
    }
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
