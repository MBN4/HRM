import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../workflow/workflow-events';
import { EXPENSE_CLAIM_ENTITY_TYPE } from './expenses.constants';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md. Mirrors
 * `OfferWorkflowEventsListener`/`JobRequisitionWorkflowEventsListener`
 * exactly: the ONE side-effect the generic engine has no way to know about
 * (flip `status`) applied here, nothing else. `PayrollRunProcessor` is
 * what later picks up an `APPROVED` claim for reimbursement — this
 * listener does not trigger that itself (a claim sits `APPROVED` until
 * it's naturally swept into that employee's next payroll run).
 */
@Injectable()
export class ExpenseWorkflowEventsListener {
  private readonly logger = new Logger(ExpenseWorkflowEventsListener.name);

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    if (payload.entityType !== EXPENSE_CLAIM_ENTITY_TYPE || !payload.entityId) {
      return;
    }
    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const claim = await tx.expenseClaim.findUnique({ where: { id: payload.entityId } });
      if (!claim || claim.status !== 'SUBMITTED') {
        return;
      }
      await tx.expenseClaim.update({ where: { id: claim.id }, data: { status, decidedAt: new Date() } });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply expense claim decision for instance "${payload.instanceId}": ${String(error)}`);
  }
}
