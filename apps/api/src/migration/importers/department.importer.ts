import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

/** Natural key: `(tenantId, branchId, name)` — the SAME `@@unique` `Department` already enforces. */
@Injectable()
export class DepartmentImporter implements EntityImporter {
  readonly entityType = 'DEPARTMENT' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const name = mappedRow.name?.trim();
    const branchName = mappedRow.branchName?.trim();
    if (!name) throw new BadRequestException('name is required.');
    if (!branchName) throw new BadRequestException('branchName is required.');

    const branch = await tx.branch.findFirst({ where: { tenantId, name: branchName }, select: { id: true } });
    if (!branch) throw new BadRequestException(`branchName "${branchName}" was not found.`);

    let parentDepartmentId: string | null = null;
    const parentDepartmentName = mappedRow.parentDepartmentName?.trim();
    if (parentDepartmentName) {
      const parent = await tx.department.findFirst({
        where: { tenantId, branchId: branch.id, name: parentDepartmentName },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException(`parentDepartmentName "${parentDepartmentName}" was not found in branch "${branchName}".`);
      parentDepartmentId = parent.id;
    }

    const existing = await tx.department.findFirst({ where: { tenantId, branchId: branch.id, name }, select: { id: true } });
    if (existing) {
      const row = await tx.department.update({ where: { id: existing.id }, data: { parentDepartmentId } });
      return { status: 'UPDATE', entityId: row.id };
    }
    const row = await tx.department.create({ data: { tenantId, branchId: branch.id, name, parentDepartmentId } });
    return { status: 'CREATE', entityId: row.id };
  }
}
