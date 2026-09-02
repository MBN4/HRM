import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Ticket, TicketAttachment, TicketComment } from '@hrm/db';
import { AddTicketCommentInput, CreateTicketInput, TicketStatusKey } from '@hrm/shared';
import { TicketCategoryService } from './ticket-category.service';

/**
 * HR Helpdesk / Ticketing — see docs/conventions/operations-modules.md.
 * Raising/commenting on YOUR OWN ticket needs only `helpdesk.write` (the
 * same "self-service, no manage-tier permission needed for your own data"
 * posture Leave/Attendance already establish); assigning/updating status
 * on ANY ticket needs `helpdesk.manage`.
 */
@Injectable()
export class TicketService {
  constructor(private readonly categories: TicketCategoryService) {}

  async create(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, input: CreateTicketInput): Promise<Ticket> {
    const category = await this.categories.requireById(tx, tenantId, input.categoryId);
    const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { id: true, branchId: true } });
    const slaDueAt = category.defaultSlaMinutes ? new Date(Date.now() + category.defaultSlaMinutes * 60_000) : null;

    return tx.ticket.create({
      data: {
        tenantId,
        categoryId: category.id,
        raisedByUserId: callerUserId,
        employeeId: own?.id ?? null,
        branchId: own?.branchId ?? null,
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        slaDueAt,
      },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: { status?: string; assignedToUserId?: string },
  ): Promise<Ticket[]> {
    const where: Prisma.TicketWhereInput = { tenantId };
    if (!canManageOthers) {
      where.raisedByUserId = callerUserId;
    } else if (allowedBranchIds) {
      where.OR = [{ branchId: { in: allowedBranchIds } }, { branchId: null }];
    }
    if (filters.status) {
      where.status = filters.status as Ticket['status'];
    }
    if (filters.assignedToUserId) {
      where.assignedToUserId = filters.assignedToUserId;
    }
    return tx.ticket.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<Ticket> {
    const ticket = await this.requireTicket(tx, tenantId, id);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    return ticket;
  }

  async addComment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
    callerUserId: string,
    canManageOthers: boolean,
    input: AddTicketCommentInput,
  ): Promise<TicketComment> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    return tx.ticketComment.create({ data: { tenantId, ticketId: ticket.id, authorUserId: callerUserId, body: input.body } });
  }

  async listComments(tx: Prisma.TransactionClient, tenantId: string, ticketId: string, callerUserId: string, canManageOthers: boolean): Promise<TicketComment[]> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    return tx.ticketComment.findMany({ where: { tenantId, ticketId: ticket.id }, orderBy: { createdAt: 'asc' } });
  }

  async addAttachment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
    callerUserId: string,
    canManageOthers: boolean,
    storageKey: string,
    fileName: string,
  ): Promise<TicketAttachment> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    return tx.ticketAttachment.create({
      data: { tenantId, ticketId: ticket.id, storageKey, fileName, uploadedByUserId: callerUserId },
    });
  }

  async listAttachments(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<TicketAttachment[]> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    return tx.ticketAttachment.findMany({ where: { tenantId, ticketId: ticket.id }, orderBy: { createdAt: 'asc' } });
  }

  async requireAttachment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
    attachmentId: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<TicketAttachment> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    this.assertCanView(ticket, callerUserId, canManageOthers);
    const attachment = await tx.ticketAttachment.findFirst({ where: { tenantId, id: attachmentId, ticketId: ticket.id } });
    if (!attachment) {
      throw new NotFoundException(`Attachment "${attachmentId}" was not found on ticket "${ticketId}".`);
    }
    return attachment;
  }

  async assign(tx: Prisma.TransactionClient, tenantId: string, ticketId: string, assignedToUserId: string): Promise<Ticket> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    return tx.ticket.update({
      where: { id: ticket.id },
      data: { assignedToUserId, status: ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status },
    });
  }

  async updateStatus(tx: Prisma.TransactionClient, tenantId: string, ticketId: string, status: TicketStatusKey): Promise<Ticket> {
    const ticket = await this.requireTicket(tx, tenantId, ticketId);
    return tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status,
        ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
        ...(status === 'CLOSED' ? { closedAt: new Date() } : {}),
      },
    });
  }

  private async requireTicket(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Ticket> {
    const ticket = await tx.ticket.findFirst({ where: { tenantId, id } });
    if (!ticket) {
      throw new NotFoundException(`Ticket "${id}" was not found.`);
    }
    return ticket;
  }

  private assertCanView(ticket: Ticket, callerUserId: string, canManageOthers: boolean): void {
    if (canManageOthers || ticket.raisedByUserId === callerUserId) {
      return;
    }
    throw new ForbiddenException('You may only view or comment on your own tickets.');
  }
}
