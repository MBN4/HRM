import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { prisma, withTenantContext, type Prisma } from '@hrm/db';
import { approverRuleSchema } from '@hrm/shared';
import { ApproverResolverService } from './approver-resolver.service';
import { WORKFLOW_EVENTS } from './workflow-events';

/**
 * The timeout-escalation sweep — a system-wide operation by nature (it
 * has to look across EVERY tenant's overdue steps, not just one), so
 * DISCOVERY queries through `prisma` (the owner/admin client), the same
 * class of cross-tenant use `LicensingAdminService` already makes of it
 * (see /CLAUDE.md § Conventions → Licensing / feature flags → Platform
 * context) — but every actual MUTATION still happens inside a proper
 * `withTenantContext` transaction for that step's own tenant, so RLS is
 * enforced for the writes exactly as it is everywhere else.
 *
 * Exposed as a plain callable method rather than wired to a real
 * scheduler (BullMQ, a cron job) — that infrastructure is out of scope
 * for this step (a notification/scheduling concern more than a workflow-
 * engine one); call it from wherever 0.8's notification hub or a future
 * scheduled job ends up living. `sweepOverdueSteps()` is safe to call
 * repeatedly/concurrently: `escalatedToUserId IS NULL` in the discovery
 * filter, plus `escalateStep`'s own re-check, means an already-escalated
 * step is never escalated twice.
 */
@Injectable()
export class WorkflowEscalationService {
  constructor(
    private readonly approverResolver: ApproverResolverService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async sweepOverdueSteps(): Promise<{ escalatedCount: number }> {
    const overdue = await prisma.workflowInstanceStep.findMany({
      where: { status: 'ACTIVE', escalatedToUserId: null, dueAt: { lt: new Date() } },
      select: { id: true, tenantId: true },
    });

    const stepIdsByTenant = new Map<string, string[]>();
    for (const row of overdue) {
      stepIdsByTenant.set(row.tenantId, [...(stepIdsByTenant.get(row.tenantId) ?? []), row.id]);
    }

    let escalatedCount = 0;
    for (const [tenantId, stepIds] of stepIdsByTenant) {
      await withTenantContext(tenantId, async (tx) => {
        for (const stepId of stepIds) {
          if (await this.escalateStep(tx, tenantId, stepId)) {
            escalatedCount += 1;
          }
        }
      });
    }
    return { escalatedCount };
  }

  private async escalateStep(tx: Prisma.TransactionClient, tenantId: string, stepId: string): Promise<boolean> {
    const step = await tx.workflowInstanceStep.findUnique({ where: { id: stepId } });
    if (!step || step.status !== 'ACTIVE' || step.escalatedToUserId) {
      return false;
    }

    const templateStep = await tx.workflowStep.findUnique({ where: { id: step.templateStepId } });
    if (!templateStep?.escalationRule) {
      return false;
    }

    const instance = await tx.workflowInstance.findUniqueOrThrow({ where: { id: step.instanceId } });
    const rule = approverRuleSchema.parse(templateStep.escalationRule);
    const escalateToIds = await this.approverResolver.resolve(tx, rule, {
      requesterId: instance.requesterId,
      dataSnapshot: instance.dataSnapshot as Record<string, unknown>,
    });
    if (escalateToIds.length === 0) {
      return false;
    }
    const escalatedToUserId = escalateToIds[0];

    await tx.workflowInstanceStep.update({ where: { id: step.id }, data: { escalatedToUserId } });
    await tx.workflowInstance.update({ where: { id: instance.id }, data: { status: 'ESCALATED' } });
    await tx.workflowAction.create({
      data: { tenantId, instanceId: instance.id, instanceStepId: step.id, actionType: 'ESCALATE', delegatedToUserId: escalatedToUserId },
    });

    this.eventEmitter.emit(WORKFLOW_EVENTS.ESCALATED, {
      type: WORKFLOW_EVENTS.ESCALATED,
      tenantId,
      instanceId: instance.id,
      instanceStepId: step.id,
      escalatedToUserId,
    });
    return true;
  }
}
