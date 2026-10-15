import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RecognitionCategory } from '@hrm/db';
import { UpsertRecognitionCategoryInput } from '@hrm/shared';

/**
 * Recognition categories ("values") are tenant-configurable DATA — see
 * docs/conventions/engagement-culture.md. A category is never deleted (past recognitions
 * reference it); it is deactivated, which only stops NEW recognitions from using it.
 */
@Injectable()
export class RecognitionCategoryService {
  async list(tx: Prisma.TransactionClient, tenantId: string, includeInactive: boolean): Promise<RecognitionCategory[]> {
    return tx.recognitionCategory.findMany({
      where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async create(tx: Prisma.TransactionClient, tenantId: string, input: UpsertRecognitionCategoryInput): Promise<RecognitionCategory> {
    await this.assertNameFree(tx, tenantId, input.name);
    return tx.recognitionCategory.create({ data: { tenantId, ...input } });
  }

  async update(tx: Prisma.TransactionClient, tenantId: string, id: string, input: UpsertRecognitionCategoryInput): Promise<RecognitionCategory> {
    const existing = await this.requireById(tx, tenantId, id);
    if (existing.name !== input.name) await this.assertNameFree(tx, tenantId, input.name, id);
    return tx.recognitionCategory.update({ where: { id }, data: input });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<RecognitionCategory> {
    const category = await tx.recognitionCategory.findFirst({ where: { tenantId, id } });
    if (!category) throw new NotFoundException(`Recognition category "${id}" was not found.`);
    return category;
  }

  private async assertNameFree(tx: Prisma.TransactionClient, tenantId: string, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.recognitionCategory.findFirst({ where: { tenantId, name, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw new ConflictException(`A recognition category named "${name}" already exists.`);
  }
}
