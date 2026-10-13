import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { SHIFT_SWAP_ENTITY_TYPE } from '@hrm/shared';
import { WORKFLOW_EVENTS } from '../workflow/workflow-events';
import { ShiftSwapService } from './shift-swap.service';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action (docs/conventions/workflow.md): a swap's ONLY connection to approval is
 * `ShiftSwapService.respond`'s `startInstance` and this listener, which reacts to the engine's own
 * `workflow.approved|rejected|canceled` events (filtered to entityType "ShiftSwap") to apply the one
 * thing the generic engine cannot know about — rewriting the two employees' roster cells. Runs
 * OUTSIDE any HTTP request, in its own tenant transaction, and never throws (the same shape
 * `AttendanceRegularizationWorkflowEventsListener` uses); the status guard in
 * `applyApproved` makes a re-delivered event harmless.
 */
@Injectable()
export class ShiftSwapWorkflowEventsListener {
  private readonly logger = new Logger(ShiftSwapWorkflowEventsListener.name);

  constructor(private readonly swaps: ShiftSwapService) {}

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((e: unknown) => this.logError(payload, e));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((e: unknown) => this.logError(payload, e));
  }

  @OnEvent(WORKFLOW_EVENTS.CANCELED)
  handleCanceled(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'CANCELED').catch((e: unknown) => this.logError(payload, e));
  }

  private async handle(
    payload: WorkflowTerminalPayload,
    status: 'APPROVED' | 'REJECTED' | 'CANCELED',
  ): Promise<void> {
    if (payload.entityType !== SHIFT_SWAP_ENTITY_TYPE || !payload.entityId) return;
    const entityId = payload.entityId;

    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      if (status === 'APPROVED') {
        await this.swaps.applyApproved(tx, payload.tenantId, entityId);
        return;
      }
      const row = await tx.shiftSwapRequest.findUnique({ where: { id: entityId } });
      if (!row || row.status !== 'PENDING_APPROVAL') return;
      await tx.shiftSwapRequest.update({
        where: { id: entityId },
        data: { status, decidedAt: new Date() },
      });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(
      `Failed to apply shift swap for instance "${payload.instanceId}": ${String(error)}`,
    );
  }
}
