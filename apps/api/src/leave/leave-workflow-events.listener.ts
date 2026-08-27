import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { LeaveBalanceService } from './leave-balance.service';
import { LEAVE_REQUEST_ENTITY_TYPE } from './leave.constants';
import { WORKFLOW_EVENTS } from '../workflow/workflow-events';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action (see docs/conventions/workflow.md): this module never
 * builds its own approve/reject/cancel logic — a leave request's ONLY
 * connection to the workflow engine is `LeaveService.submit`'s
 * `startInstance` call and this listener, which reacts to the engine's own
 * `workflow.approved`/`workflow.rejected`/`workflow.canceled` events
 * (filtered to `entityType === "LeaveRequest"`) to apply the one
 * leave-specific side-effect the generic engine has no way to know about:
 * deducting/restoring a `LeaveBalance`.
 *
 * Runs OUTSIDE any HTTP request — `WorkflowEngineService.finalize` emits
 * fire-and-forget, exactly the same asynchronous-dispatch shape
 * `NotificationDispatchListener` (0.8) and `DomainEventAuditListener` (0.9)
 * already document for themselves — so this opens its OWN
 * `withTenantContext` transaction rather than reusing the emitting
 * request's, and never throws (logs and swallows): the mutation this event
 * describes already happened and already returned a response to its
 * caller.
 *
 * `LeaveRequest.balanceApplied` guards against double-deducting/-restoring
 * if an event were ever (re)delivered more than once. Only APPROVED
 * actually deducts: 0.7's engine treats `APPROVED` as a TERMINAL status
 * (see `WorkflowEngineService`'s `TERMINAL_STATUSES`), so an already-
 * approved instance can never reach `workflow.rejected`/`workflow.canceled`
 * afterward through the generic engine — REJECTED/CANCELED can only arrive
 * from a still-PENDING instance, before any deduction ever happened, so
 * their "restore" branch is a documented no-op today (kept for
 * correctness/symmetry, and in case a future path ever reverses an
 * approval).
 */
@Injectable()
export class LeaveWorkflowEventsListener {
  private readonly logger = new Logger(LeaveWorkflowEventsListener.name);

  constructor(private readonly balances: LeaveBalanceService) {}

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.CANCELED)
  handleCanceled(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'CANCELED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED' | 'CANCELED'): Promise<void> {
    if (payload.entityType !== LEAVE_REQUEST_ENTITY_TYPE || !payload.entityId) {
      return;
    }

    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const row = await tx.leaveRequest.findUnique({ where: { id: payload.entityId } });
      if (!row || row.status !== 'PENDING') {
        // Already resolved (or not found) — nothing to do; guards against a redelivered event.
        return;
      }

      const periodYear = row.startDate.getUTCFullYear();

      if (status === 'APPROVED') {
        await this.balances.deduct(tx, payload.tenantId, row.employeeId, row.leaveType, periodYear, row.days);
        await tx.leaveRequest.update({
          where: { id: row.id },
          data: { status: 'APPROVED', balanceApplied: true, decidedAt: new Date() },
        });
        return;
      }

      if (row.balanceApplied) {
        await this.balances.restore(tx, payload.tenantId, row.employeeId, row.leaveType, periodYear, row.days);
      }
      await tx.leaveRequest.update({
        where: { id: row.id },
        data: { status, balanceApplied: false, decidedAt: new Date() },
      });
    });
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply leave balance effect for instance "${payload.instanceId}": ${String(error)}`);
  }
}
