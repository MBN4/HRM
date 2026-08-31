import type { Employee, Prisma, ReviewType } from '@hrm/db';

/**
 * Resolves reviewer Employee ids for the AUTO-resolvable review types via
 * the REAL 1.1 org chart — `Employee.managerId`/the manager self-relation —
 * exactly the data `ApproverResolverService`'s own `MANAGER` rule already
 * resolves through (see docs/conventions/employee.md → Feeding the workflow
 * engine), just stopping at the Employee rather than continuing on to a
 * User the way a workflow approver rule does. PEER is never resolved
 * here — it always requires an explicit assignment (see
 * `AppraisalCycleService.open`/`ReviewService.assignPeers`).
 *
 * An employee with no manager gets no MANAGER row; an employee with no
 * direct reports gets no UPWARD rows — both are documented gaps, not
 * errors, mirroring `OrgChartService`'s own "no manager -> root, not
 * dropped" posture for a structurally absent relationship.
 */
export async function resolveAutoReviewers(
  tx: Prisma.TransactionClient,
  employee: Employee,
): Promise<{ reviewType: ReviewType; reviewerId: string }[]> {
  const assignments: { reviewType: ReviewType; reviewerId: string }[] = [{ reviewType: 'SELF', reviewerId: employee.id }];

  if (employee.managerId) {
    assignments.push({ reviewType: 'MANAGER', reviewerId: employee.managerId });
  }

  const directReports = await tx.employee.findMany({ where: { managerId: employee.id, status: 'ACTIVE' }, select: { id: true } });
  for (const report of directReports) {
    assignments.push({ reviewType: 'UPWARD', reviewerId: report.id });
  }

  return assignments;
}
