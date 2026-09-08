import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../workflow/workflow-events';
import { BENEFIT_ENROLLMENT_ENTITY_TYPE } from './benefits.constants';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md. Mirrors
 * `ExpenseWorkflowEventsListener` exactly: the ONE side-effect the generic
 * engine has no way to know about (flip `status`) applied here, nothing
 * else. `PayrollRunProcessor` picks up an `ACTIVE` enrollment on its own
 * next payroll run — this listener does not trigger that itself.
 */
@Injectable()
export class BenefitsWorkflowEventsListener {
  private readonly logger = new Logger(BenefitsWorkflowEventsListener.name);

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'ACTIVE').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'CANCELLED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'ACTIVE' | 'CANCELLED'): Promise<void> {
    if (payload.entityType !== BENEFIT_ENROLLMENT_ENTITY_TYPE || !payload.entityId) {
      return;
    }
    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const enrollment = await tx.benefitEnrollment.findUnique({ where: { id: payload.entityId } });
      if (!enrollment || enrollment.status !== 'PENDING_APPROVAL') {
        return;
      }
      await tx.benefitEnrollment.update({ where: { id: enrollment.id }, data: { status } });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply benefit enrollment decision for instance "${payload.instanceId}": ${String(error)}`);
  }
}
