import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RequiredTraining } from '@hrm/db';
import { UpsertRequiredTrainingInput } from '@hrm/shared';

/**
 * Which courses a role and/or branch must hold — CONFIG AS DATA, per this
 * step's brief. See the `RequiredTraining` schema doc comment for why
 * `roleId`/`branchId` are independently nullable ("unrestricted") and why
 * there's no unique constraint spanning them.
 */
@Injectable()
export class RequiredTrainingService {
  async create(tx: Prisma.TransactionClient, tenantId: string, input: UpsertRequiredTrainingInput): Promise<RequiredTraining> {
    const course = await tx.course.findFirst({ where: { tenantId, id: input.courseId } });
    if (!course) {
      throw new NotFoundException(`Course "${input.courseId}" was not found.`);
    }
    return tx.requiredTraining.create({
      data: { tenantId, courseId: input.courseId, roleId: input.roleId ?? null, branchId: input.branchId ?? null },
    });
  }

  async list(tx: Prisma.TransactionClient, tenantId: string, filters: { courseId?: string }): Promise<RequiredTraining[]> {
    const where: Prisma.RequiredTrainingWhereInput = { tenantId, isActive: true };
    if (filters.courseId) {
      where.courseId = filters.courseId;
    }
    return tx.requiredTraining.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async deactivate(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<RequiredTraining> {
    const row = await tx.requiredTraining.findFirst({ where: { tenantId, id } });
    if (!row) {
      throw new NotFoundException(`Required training rule "${id}" was not found.`);
    }
    return tx.requiredTraining.update({ where: { id: row.id }, data: { isActive: false } });
  }
}
