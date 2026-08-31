import type { Prisma } from '@hrm/db';
import { SYSTEM_ROLES, type ChecklistAssigneeRule } from '@hrm/shared';

/**
 * Resolves ONE `ChecklistAssigneeRule` (`SPECIFIC_USER`/`ROLE`/`MANAGER`)
 * against a single employee's context — see
 * `packages/shared/src/validators/checklist.validator.ts` for why this is
 * a small, purpose-built shape/resolver, not 0.7's `ApproverRule`/
 * `ApproverResolverService` reused. `MANAGER` resolves through the REAL
 * 1.1 org chart (`Employee.managerId`), same data
 * `ApproverResolverService`'s own `MANAGER` rule and Performance's
 * `resolveAutoReviewers` already resolve through. `ROLE` picks the first
 * `ACTIVE` user holding that role in the tenant (deterministic by
 * `createdAt`) — a checklist task needs exactly ONE assignee, unlike a
 * workflow step's whole eligible-approver SET, so this doesn't need
 * `ApproverResolverService`'s "resolve every eligible id" shape either.
 * Returns `null` (never throws) when the rule can't be resolved — e.g. a
 * `MANAGER` rule for an employee with no manager — a documented gap
 * (the task instance is simply created with no assignee), not a silent
 * failure or a blocked checklist.
 */
export async function resolveChecklistAssignee(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rule: ChecklistAssigneeRule,
  employeeId: string,
): Promise<string | null> {
  switch (rule.type) {
    case 'SPECIFIC_USER':
      return rule.userId;

    case 'MANAGER': {
      const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { managerId: true } });
      if (!employee?.managerId) {
        return null;
      }
      const manager = await tx.employee.findUnique({ where: { id: employee.managerId }, select: { userId: true } });
      return manager?.userId ?? null;
    }

    case 'ROLE': {
      const holder = await tx.userRole.findFirst({
        where: { tenantId, role: { name: rule.roleName }, user: { status: 'ACTIVE' } },
        orderBy: { user: { createdAt: 'asc' } },
        select: { userId: true },
      });
      return holder?.userId ?? null;
    }

    default:
      return null;
  }
}

/** A `ROLE` rule targeting `HR_MANAGER` is the common default for HR-owned checklist tasks — exported so template seeding/tests don't hardcode the literal string. */
export const HR_ROLE_ASSIGNEE_RULE: ChecklistAssigneeRule = { type: 'ROLE', roleName: SYSTEM_ROLES.HR_MANAGER };
