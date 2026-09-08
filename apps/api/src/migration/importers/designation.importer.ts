import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

/** Natural key: `(tenantId, name)` — the SAME `@@unique` `Designation` already enforces. Nothing else to update, so a match is always SKIP, never UPDATE. */
@Injectable()
export class DesignationImporter implements EntityImporter {
  readonly entityType = 'DESIGNATION' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const name = mappedRow.name?.trim();
    if (!name) throw new BadRequestException('name is required.');

    const existing = await tx.designation.findFirst({ where: { tenantId, name }, select: { id: true } });
    if (existing) {
      return { status: 'SKIP', entityId: existing.id };
    }
    const row = await tx.designation.create({ data: { tenantId, name } });
    return { status: 'CREATE', entityId: row.id };
  }
}
