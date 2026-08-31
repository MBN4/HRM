import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../../workflow/workflow-events';
import { PERFORMANCE_APPRAISAL_ENTITY_TYPE } from '../performance.constants';
import { CalibrationQueueService } from '../calibration/calibration-queue.service';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md and
 * `PayrollWorkflowEventsListener`/`LeaveWorkflowEventsListener` for the
 * identical shape this mirrors. An appraisal's ONLY connection to the
 * workflow engine is `AppraisalService.submitForApproval`'s `startInstance`
 * call and this listener, reacting to `workflow.approved`/
 * `workflow.rejected` (filtered to `entityType === "PerformanceAppraisal"`)
 * to apply the one side-effect the generic engine has no way to know
 * about: flipping the appraisal to `COMPLETED`/`REJECTED`. Runs OUTSIDE any
 * HTTP request — opens its OWN `withTenantContext` transaction, never
 * throws (logs and swallows).
 */
@Injectable()
export class AppraisalWorkflowEventsListener {
  private readonly logger = new Logger(AppraisalWorkflowEventsListener.name);

  constructor(private readonly calibrationQueue: CalibrationQueueService) {}

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'COMPLETED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'COMPLETED' | 'REJECTED'): Promise<void> {
    if (payload.entityType !== PERFORMANCE_APPRAISAL_ENTITY_TYPE || !payload.entityId) {
      return;
    }

    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const appraisal = await tx.appraisal.findUnique({ where: { id: payload.entityId } });
      if (!appraisal || appraisal.status !== 'PENDING_SIGNOFF') {
        // Already resolved (or not found) — guards a redelivered event.
        return;
      }
      await tx.appraisal.update({
        where: { id: appraisal.id },
        data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
      });

      if (status === 'COMPLETED') {
        await this.calibrationQueue.enqueueRecompute(payload.tenantId, appraisal.cycleId);
      }
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply appraisal sign-off effect for instance "${payload.instanceId}": ${String(error)}`);
  }
}
