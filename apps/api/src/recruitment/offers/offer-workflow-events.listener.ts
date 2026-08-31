import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../../workflow/workflow-events';
import { OFFER_ENTITY_TYPE } from '../recruitment.constants';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md. `REJECTED` here
 * means the internal APPROVAL was rejected (an approver said no to sending
 * this offer at all) — distinct from `DECLINED` (`OfferService.decline`,
 * the candidate turning down an already-APPROVED offer). Mirrors
 * `PayrollWorkflowEventsListener`/`JobRequisitionWorkflowEventsListener`
 * exactly.
 */
@Injectable()
export class OfferWorkflowEventsListener {
  private readonly logger = new Logger(OfferWorkflowEventsListener.name);

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    if (payload.entityType !== OFFER_ENTITY_TYPE || !payload.entityId) {
      return;
    }
    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const offer = await tx.offer.findUnique({ where: { id: payload.entityId } });
      if (!offer || offer.status !== 'PENDING_APPROVAL') {
        return;
      }
      await tx.offer.update({ where: { id: offer.id }, data: { status } });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply offer decision for instance "${payload.instanceId}": ${String(error)}`);
  }
}
