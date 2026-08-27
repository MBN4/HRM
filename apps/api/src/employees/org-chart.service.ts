import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';

export interface OrgChartNode {
  id: string;
  firstName: string;
  lastName: string;
  designationId: string | null;
  directReports: OrgChartNode[];
}

/**
 * Derives the reporting hierarchy from `Employee.managerId` — see
 * docs/conventions/employee.md. Only `ACTIVE` employees are included (an
 * org chart showing a terminated employee's old reporting line would be
 * actively misleading). Branch-scoped the same way employee list/get are
 * (see docs/conventions/auth-rbac.md → Branch scoping): a restricted caller
 * only ever sees the hierarchy within their allowed branches.
 */
@Injectable()
export class OrgChartService {
  async build(
    tx: Prisma.TransactionClient,
    branchId: string | undefined,
    allowedBranchIds: string[] | null,
  ): Promise<OrgChartNode[]> {
    if (branchId && allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException(`You are not permitted to view the org chart for branch "${branchId}".`);
    }

    const where: Prisma.EmployeeWhereInput = { status: 'ACTIVE' };
    if (branchId) {
      where.branchId = branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }

    const rows = await tx.employee.findMany({
      where,
      select: { id: true, firstName: true, lastName: true, designationId: true, managerId: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const nodesById = new Map<string, OrgChartNode>(
      rows.map((row) => [
        row.id,
        { id: row.id, firstName: row.firstName, lastName: row.lastName, designationId: row.designationId, directReports: [] },
      ]),
    );

    const roots: OrgChartNode[] = [];
    for (const row of rows) {
      const node = nodesById.get(row.id)!;
      const managerNode = row.managerId ? nodesById.get(row.managerId) : undefined;
      if (managerNode) {
        managerNode.directReports.push(node);
      } else {
        // No manager, or a manager outside this query's scope (different
        // branch/inactive) — treat as a root rather than silently dropping
        // this employee from the chart.
        roots.push(node);
      }
    }
    return roots;
  }
}
