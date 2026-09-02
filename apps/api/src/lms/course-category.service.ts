import { Injectable, NotFoundException } from '@nestjs/common';
import type { CourseCategory, Prisma } from '@hrm/db';
import { CreateCourseCategoryInput } from '@hrm/shared';

/** Course category CRUD — the SAME upsert-by-natural-key shape `ExpenseCategoryService`/`TicketCategoryService` already establish. */
@Injectable()
export class CourseCategoryService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateCourseCategoryInput): Promise<CourseCategory> {
    return tx.courseCategory.upsert({
      where: { tenantId_code: { tenantId, code: input.code } },
      update: { name: input.name, isActive: true },
      create: { tenantId, code: input.code, name: input.name },
    });
  }

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<CourseCategory[]> {
    return tx.courseCategory.findMany({ where: { tenantId, isActive: true }, orderBy: { name: 'asc' } });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<CourseCategory> {
    const category = await tx.courseCategory.findFirst({ where: { tenantId, id } });
    if (!category) {
      throw new NotFoundException(`Course category "${id}" was not found.`);
    }
    return category;
  }
}
