import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { approverRuleSchema } from '@hrm/shared';
import type { ChainRouting } from './approval-chain';
import { ApproverResolverService } from './approver-resolver.service';

/**
 * Re-resolves the approvers of steps that are ALREADY waiting on a human when
 * the management chain changes underneath them (step 7.2): a manager is
 * deactivated / reactivated, or someone's manager is reassigned. Without this
 * only FUTURE requests would pick up the new chain; a request submitted
 * yesterday would sit forever in the inbox of someone who has since left.
 *
 * Only steps whose approvers were produced by the hierarchical `MANAGER` rule
 * (those carry `routing`) and that have NOT been explicitly delegated or
 * time-escalated are touched — a deliberate human reassignment is honoured.
 * The approver lists are re-derived from the live chain (same resolver as at
 * activation), so the result is exactly what a fresh submission would get.
 */
@Injectable()
export class WorkflowRoutingService {
  constructor(private readonly resolver: ApproverResolverService) {}

  /** Returns the number of steps whose approvers actually changed. */
  async rerouteActiveChainSteps(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    const steps = await tx.workflowInstanceStep.findMany({
      where: { status: 'ACTIVE', delegatedToUserId: null, escalatedToUserId: null },
      include: { instance: true, templateStep: true },
    });

    let changed = 0;
    for (const step of steps) {
      if (!step.routing) continue;
      const instance = step.instance;
      if (instance.status === 'APPROVED' || instance.status === 'REJECTED' || instance.status === 'CANCELED') continue;

      const rule = approverRuleSchema.parse(step.templateStep.approverRule);
      const { approverIds, routing } = await this.resolver.resolveDetailed(tx, rule, {
        requesterId: instance.requesterId,
        dataSnapshot: instance.dataSnapshot as Record<string, unknown>,
      });

      const before = [...(step.eligibleApproverIds as string[])].sort().join(',');
      const after = [...approverIds].sort().join(',');
      const previous = step.routing as unknown as ChainRouting;
      if (before === after && previous.kind === routing?.kind) continue;

      await tx.workflowInstanceStep.update({
        where: { id: step.id },
        data: { eligibleApproverIds: approverIds, routing: routing as unknown as Prisma.InputJsonValue },
      });
      await tx.workflowAction.create({
        data: {
          tenantId,
          instanceId: instance.id,
          instanceStepId: step.id,
          actionType: 'ESCALATE',
          comment: `Re-routed after the management chain changed: ${previous.kind} -> ${routing?.kind ?? 'NONE'}.`,
        },
      });
      changed += 1;
    }
    return changed;
  }
}
