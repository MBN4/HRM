import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssetCategory, Prisma } from '@hrm/db';
import { CreateAssetCategoryInput } from '@hrm/shared';

/** Asset category CRUD — the SAME upsert-by-`(tenantId, code)` shape `ExpenseCategoryService`/`ChecklistTemplateService` already establish. */
@Injectable()
export class AssetCategoryService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateAssetCategoryInput): Promise<AssetCategory> {
    return tx.assetCategory.upsert({
      where: { tenantId_code: { tenantId, code: input.code } },
      update: { name: input.name, isActive: true },
      create: { tenantId, code: input.code, name: input.name },
    });
  }

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<AssetCategory[]> {
    return tx.assetCategory.findMany({ where: { tenantId, isActive: true }, orderBy: { name: 'asc' } });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<AssetCategory> {
    const category = await tx.assetCategory.findFirst({ where: { tenantId, id } });
    if (!category) {
      throw new NotFoundException(`Asset category "${id}" was not found.`);
    }
    return category;
  }
}
