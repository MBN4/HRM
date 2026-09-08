import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ColumnMappingTemplate, Prisma } from '@hrm/db';
import type { ImportEntityTypeKey, SaveColumnMappingTemplateInput } from '@hrm/shared';

/** Tenant-reusable column mappings — see docs/conventions/data-migration.md. Plain CRUD, no business rules beyond the `(tenantId, entityType, name)` uniqueness the schema already enforces. */
@Injectable()
export class ColumnMappingTemplateService {
  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    createdByUserId: string | null,
    input: SaveColumnMappingTemplateInput,
  ): Promise<ColumnMappingTemplate> {
    const existing = await tx.columnMappingTemplate.findUnique({
      where: { tenantId_entityType_name: { tenantId, entityType: input.entityType, name: input.name } },
    });
    if (existing) {
      throw new ConflictException(`A mapping template named "${input.name}" already exists for ${input.entityType}.`);
    }
    return tx.columnMappingTemplate.create({
      data: { tenantId, entityType: input.entityType, name: input.name, mapping: input.mapping, createdByUserId },
    });
  }

  async list(tx: Prisma.TransactionClient, entityType?: ImportEntityTypeKey): Promise<ColumnMappingTemplate[]> {
    return tx.columnMappingTemplate.findMany({
      where: entityType ? { entityType } : {},
      orderBy: { name: 'asc' },
    });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<ColumnMappingTemplate> {
    const row = await tx.columnMappingTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Mapping template "${id}" was not found.`);
    return row;
  }

  async remove(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await this.findById(tx, id);
    await tx.columnMappingTemplate.delete({ where: { id } });
  }
}
