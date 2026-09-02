import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, TicketCategory } from '@hrm/db';
import { CreateTicketCategoryInput } from '@hrm/shared';

/** Ticket category CRUD — `defaultSlaMinutes` is tenant-configurable DATA, the SAME upsert-by-`(tenantId, code)` shape every other reference-config service in this codebase already establishes. */
@Injectable()
export class TicketCategoryService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateTicketCategoryInput): Promise<TicketCategory> {
    return tx.ticketCategory.upsert({
      where: { tenantId_code: { tenantId, code: input.code } },
      update: { name: input.name, defaultSlaMinutes: input.defaultSlaMinutes ?? null, isActive: true },
      create: { tenantId, code: input.code, name: input.name, defaultSlaMinutes: input.defaultSlaMinutes ?? null },
    });
  }

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<TicketCategory[]> {
    return tx.ticketCategory.findMany({ where: { tenantId, isActive: true }, orderBy: { name: 'asc' } });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<TicketCategory> {
    const category = await tx.ticketCategory.findFirst({ where: { tenantId, id } });
    if (!category) {
      throw new NotFoundException(`Ticket category "${id}" was not found.`);
    }
    return category;
  }
}
