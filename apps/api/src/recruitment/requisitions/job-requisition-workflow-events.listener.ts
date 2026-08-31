import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../../workflow/workflow-events';
import { JOB_REQUISITION_ENTITY_TYPE } from '../recruitment.constants';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/** THE RULE in action — see docs/conventions/workflow.md. Mirrors `PayrollWorkflowEventsListener`/`AppraisalWorkflowEventsListener` exactly. */
@Injectable()
export class JobRequisitionWorkflowEventsListener {
  private readonly logger = new Logger(JobRequisitionWorkflowEventsListener.name);

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    if (payload.entityType !== JOB_REQUISITION_ENTITY_TYPE || !payload.entityId) {
      return;
    }
    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const requisition = await tx.jobRequisition.findUnique({ where: { id: payload.entityId } });
      if (!requisition || requisition.status !== 'PENDING_APPROVAL') {
        return;
      }
      await tx.jobRequisition.update({
        where: { id: requisition.id },
        data: { status, approvedAt: status === 'APPROVED' ? new Date() : null },
      });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply job requisition decision for instance "${payload.instanceId}": ${String(error)}`);
  }
}
