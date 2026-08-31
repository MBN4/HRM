import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RatingScale } from '@hrm/db';
import { CreateRatingScaleInput } from '@hrm/shared';

/**
 * Rating scales as DATA — see docs/conventions/performance.md. `upsert`
 * keyed on `(tenantId, key)` (matching `PayrollComponentDefinitionService`'s
 * own upsert-by-natural-key shape) so re-declaring the same scale key
 * updates it in place rather than accumulating duplicates.
 */
@Injectable()
export class RatingScaleService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateRatingScaleInput): Promise<RatingScale> {
    return tx.ratingScale.upsert({
      where: { tenantId_key: { tenantId, key: input.key } },
      update: { name: input.name, levels: input.levels as Prisma.InputJsonValue, isActive: true },
      create: { tenantId, key: input.key, name: input.name, levels: input.levels as Prisma.InputJsonValue },
    });
  }

  async list(tx: Prisma.TransactionClient): Promise<RatingScale[]> {
    return tx.ratingScale.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  async requireByKey(tx: Prisma.TransactionClient, tenantId: string, key: string): Promise<RatingScale> {
    const scale = await tx.ratingScale.findUnique({ where: { tenantId_key: { tenantId, key } } });
    if (!scale) {
      throw new NotFoundException(`Rating scale "${key}" was not found.`);
    }
    return scale;
  }
}
