import { Injectable } from '@nestjs/common';
import type { ChecklistProcessType, ChecklistTemplate, Prisma } from '@hrm/db';
import { CreateChecklistTemplateInput } from '@hrm/shared';

/** Checklist template CRUD — DATA, per this step's "checklists as configurable data" brief. Upsert-by-`(tenantId, processType, name)`, the same natural-key-upsert shape `RatingScaleService`/`PayrollComponentDefinitionService` already establish. */
@Injectable()
export class ChecklistTemplateService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateChecklistTemplateInput): Promise<ChecklistTemplate> {
    return tx.checklistTemplate.upsert({
      where: { tenantId_processType_name: { tenantId, processType: input.processType, name: input.name } },
      update: { tasks: input.tasks as Prisma.InputJsonValue, isActive: true },
      create: { tenantId, processType: input.processType, name: input.name, tasks: input.tasks as Prisma.InputJsonValue },
    });
  }

  async list(tx: Prisma.TransactionClient, processType?: ChecklistProcessType): Promise<ChecklistTemplate[]> {
    return tx.checklistTemplate.findMany({
      where: { isActive: true, ...(processType ? { processType } : {}) },
      orderBy: { name: 'asc' },
    });
  }
}
