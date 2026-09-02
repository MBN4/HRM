import { Injectable, NotFoundException } from '@nestjs/common';
import type { ExpenseCategory, Prisma } from '@hrm/db';
import { CreateExpenseCategoryInput } from '@hrm/shared';

/**
 * Expense category CRUD — tenant-configurable policy-limit DATA (per this
 * step's brief), the same upsert-by-natural-key shape
 * `ChecklistTemplateService`/`PayrollComponentDefinitionService` already
 * establish.
 */
@Injectable()
export class ExpenseCategoryService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateExpenseCategoryInput): Promise<ExpenseCategory> {
    return tx.expenseCategory.upsert({
      where: { tenantId_code: { tenantId, code: input.code } },
      update: { name: input.name, policyLimitAmount: input.policyLimitAmount ?? null, isActive: true },
      create: { tenantId, code: input.code, name: input.name, policyLimitAmount: input.policyLimitAmount ?? null },
    });
  }

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<ExpenseCategory[]> {
    return tx.expenseCategory.findMany({ where: { tenantId, isActive: true }, orderBy: { name: 'asc' } });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<ExpenseCategory> {
    const category = await tx.expenseCategory.findFirst({ where: { tenantId, id } });
    if (!category) {
      throw new NotFoundException(`Expense category "${id}" was not found.`);
    }
    return category;
  }

  /** Deactivate, never delete — existing claims must keep resolving their category (the FK is `onDelete: Restrict`), and `isActive: false` simply stops it appearing in future picker lists. */
  async deactivate(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<ExpenseCategory> {
    const category = await this.requireById(tx, tenantId, id);
    return tx.expenseCategory.update({ where: { id: category.id }, data: { isActive: false } });
  }
}
