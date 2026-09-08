import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

/** Natural key: `(tenantId, code)` — the SAME `@@unique` `CostCenter` already enforces. */
@Injectable()
export class CostCenterImporter implements EntityImporter {
  readonly entityType = 'COST_CENTER' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const name = mappedRow.name?.trim();
    const code = mappedRow.code?.trim();
    if (!name) throw new BadRequestException('name is required.');
    if (!code) throw new BadRequestException('code is required.');

    const existing = await tx.costCenter.findUnique({ where: { tenantId_code: { tenantId, code } } });
    if (existing) {
      const row = await tx.costCenter.update({ where: { id: existing.id }, data: { name } });
      return { status: 'UPDATE', entityId: row.id };
    }
    const row = await tx.costCenter.create({ data: { tenantId, name, code } });
    return { status: 'CREATE', entityId: row.id };
  }
}
