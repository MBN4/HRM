import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { WORKFLOW_EVENTS } from '../../workflow/workflow-events';
import { PAYROLL_RUN_ENTITY_TYPE } from '../payroll.constants';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * THE RULE in action — see docs/conventions/workflow.md and
 * `LeaveWorkflowEventsListener`/`AttendanceRegularizationWorkflowEventsListener`
 * for the identical shape this mirrors. A payroll run's ONLY connection to
 * the workflow engine is `PayrollRunService.submitForApproval`'s
 * `startInstance` call and this listener, which reacts to the engine's own
 * `workflow.approved` event (filtered to `entityType === "PayrollRun"`) to
 * apply the one payroll-specific side-effect the generic engine has no way
 * to know about: flipping the run from `CALCULATED` to `APPROVED` — the
 * lifecycle's own explicit "approved" stage (per docs/conventions/payroll.md,
 * `draft → calculated → approved → finalized/paid`). `finalize`/`markPaid`
 * remain SEPARATE, deliberate business actions
 * (`PayrollRunService.finalize`/`markPaid`, `payroll.approve`-gated) — this
 * listener only ever performs the ONE transition the workflow decision
 * itself represents. Runs OUTSIDE any HTTP request (fire-and-forget, same
 * as every other workflow-event listener in this codebase) — opens its OWN
 * `withTenantContext` transaction, never throws (logs and swallows).
 */
@Injectable()
export class PayrollWorkflowEventsListener {
  private readonly logger = new Logger(PayrollWorkflowEventsListener.name);

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload).catch((error: unknown) => {
      this.logger.error(`Failed to mark payroll run APPROVED for instance "${payload.instanceId}": ${String(error)}`);
    });
  }

  private async handle(payload: WorkflowTerminalPayload): Promise<void> {
    if (payload.entityType !== PAYROLL_RUN_ENTITY_TYPE || !payload.entityId) {
      return;
    }

    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const run = await tx.payrollRun.findUnique({ where: { id: payload.entityId } });
      if (!run || run.status !== 'CALCULATED') {
        // Already APPROVED/beyond, or not found — guards a redelivered event.
        return;
      }
      await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    });
  }
}
