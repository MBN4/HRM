import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../workflow/workflow-events';
import { OFFBOARDING_PROCESS_ENTITY_TYPE } from './offboarding.constants';
import { OffboardingService } from './offboarding.service';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md. On `APPROVED`,
 * also instantiates the tenant's OFFBOARDING clearance checklist
 * (`OffboardingService.instantiateChecklist`) — the one side-effect the
 * generic engine has no way to know about, mirroring
 * `PayrollWorkflowEventsListener`/`AppraisalWorkflowEventsListener`'s exact
 * shape.
 */
@Injectable()
export class OffboardingWorkflowEventsListener {
  private readonly logger = new Logger(OffboardingWorkflowEventsListener.name);

  constructor(private readonly offboarding: OffboardingService) {}

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    if (payload.entityType !== OFFBOARDING_PROCESS_ENTITY_TYPE || !payload.entityId) {
      return;
    }
    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const process = await tx.offboardingProcess.findUnique({ where: { id: payload.entityId } });
      if (!process || process.status !== 'PENDING_APPROVAL') {
        return;
      }
      const updated = await tx.offboardingProcess.update({ where: { id: process.id }, data: { status } });
      if (status === 'APPROVED') {
        await this.offboarding.instantiateChecklist(tx, payload.tenantId, updated);
      }
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply offboarding decision for instance "${payload.instanceId}": ${String(error)}`);
  }
}
