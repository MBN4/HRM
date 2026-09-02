import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { prisma, withTenantContext } from '@hrm/db';

/**
 * The SLA-breach escalation sweep — the SAME shape/posture
 * `WorkflowEscalationService.sweepOverdueSteps` already establishes (see
 * docs/conventions/workflow.md): a system-wide DISCOVERY query through
 * `prisma` (the owner/admin client, since this has to look across every
 * tenant's overdue tickets), every actual MUTATION inside a proper
 * `withTenantContext` transaction for that ticket's own tenant so RLS
 * still applies to the write. Not wired to a real scheduler (BullMQ, a
 * cron job) — out of this step's scope, exactly like 0.7's own escalation
 * sweep; call it from wherever a future scheduled job ends up living.
 * Safe to call repeatedly/concurrently: `slaBreached: false` in the
 * discovery filter, plus a re-check inside the per-ticket transaction,
 * means an already-escalated ticket is never escalated twice.
 */
@Injectable()
export class TicketSlaService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  async sweepOverdueTickets(): Promise<{ escalatedCount: number }> {
    const overdue = await prisma.ticket.findMany({
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, slaBreached: false, slaDueAt: { lt: new Date() } },
      select: { id: true, tenantId: true },
    });

    let escalatedCount = 0;
    for (const row of overdue) {
      const escalated = await withTenantContext(row.tenantId, async (tx) => {
        const ticket = await tx.ticket.findUnique({ where: { id: row.id } });
        if (!ticket || ticket.slaBreached || !['OPEN', 'IN_PROGRESS'].includes(ticket.status)) {
          return false;
        }
        await tx.ticket.update({ where: { id: ticket.id }, data: { slaBreached: true } });
        this.eventEmitter.emit('helpdesk.ticket_escalated', {
          type: 'helpdesk.ticket_escalated',
          tenantId: row.tenantId,
          ticketId: ticket.id,
          assignedToUserId: ticket.assignedToUserId,
        });
        return true;
      });
      if (escalated) {
        escalatedCount += 1;
      }
    }
    return { escalatedCount };
  }
}
