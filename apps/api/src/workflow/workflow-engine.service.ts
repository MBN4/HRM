import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, WorkflowInstance, WorkflowInstanceStep } from '@hrm/db';
import { approverRuleSchema, WorkflowStepActionInput, workflowConditionSchema } from '@hrm/shared';
import { ApproverResolverService } from './approver-resolver.service';
import { evaluateWorkflowCondition } from './condition-evaluator';
import { WORKFLOW_EVENTS } from './workflow-events';

export interface StartInstanceParams {
  requesterId: string;
  entityType: string;
  entityId: string;
  dataSnapshot: Record<string, unknown>;
}

const TERMINAL_STATUSES = new Set(['APPROVED', 'REJECTED', 'CANCELED']);

/**
 * The ONE generic workflow/approval engine — see /CLAUDE.md § Conventions
 * → Workflow engine for the full state-machine write-up. Every method
 * takes the caller's tenant-scoped transaction (`tx`) and an explicit
 * `tenantId` (needed for `data: { tenantId, ... }` on every write — `tx`
 * itself doesn't expose the bound tenant reflectively), exactly the
 * pattern `CountryPackResolutionService`/`FeatureFlagResolutionService`
 * already use.
 */
@Injectable()
export class WorkflowEngineService {
  constructor(
    private readonly approverResolver: ApproverResolverService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Resolves the active template for `params.entityType`, materializes
   * ONE `WorkflowInstanceStep` per template step (evaluating each step's
   * `condition` against `dataSnapshot` right away — SKIPPED if false, so
   * the "which steps actually apply" decision is made once, up front, and
   * never re-evaluated later even if the template changes), then
   * activates the first non-skipped step group.
   */
  async startInstance(tx: Prisma.TransactionClient, tenantId: string, params: StartInstanceParams): Promise<WorkflowInstance> {
    const template = await tx.workflowTemplate.findFirst({
      where: { entityType: params.entityType, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!template) {
      throw new NotFoundException(`No active workflow template is configured for entity type "${params.entityType}".`);
    }

    const templateSteps = await tx.workflowStep.findMany({ where: { templateId: template.id }, orderBy: { order: 'asc' } });
    if (templateSteps.length === 0) {
      throw new BadRequestException(`Workflow template "${template.name}" has no steps configured.`);
    }

    const instance = await tx.workflowInstance.create({
      data: {
        tenantId,
        templateId: template.id,
        entityType: params.entityType,
        entityId: params.entityId,
        requesterId: params.requesterId,
        dataSnapshot: params.dataSnapshot as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });

    for (const step of templateSteps) {
      const applies = step.condition
        ? evaluateWorkflowCondition(workflowConditionSchema.parse(step.condition), params.dataSnapshot)
        : true;
      await tx.workflowInstanceStep.create({
        data: {
          tenantId,
          instanceId: instance.id,
          templateStepId: step.id,
          name: step.name,
          order: step.order,
          status: applies ? 'PENDING' : 'SKIPPED',
          eligibleApproverIds: [],
        },
      });
    }

    this.eventEmitter.emit(WORKFLOW_EVENTS.SUBMITTED, {
      type: WORKFLOW_EVENTS.SUBMITTED,
      tenantId,
      instanceId: instance.id,
      entityType: instance.entityType,
      entityId: instance.entityId,
      requesterId: instance.requesterId,
    });

    return this.activateNextGroup(tx, tenantId, instance);
  }

  async getInstanceDetail(tx: Prisma.TransactionClient, instanceId: string, callerId: string, canManage: boolean) {
    const instance = await tx.workflowInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Workflow instance "${instanceId}" was not found.`);
    }

    const steps = await tx.workflowInstanceStep.findMany({ where: { instanceId }, orderBy: { order: 'asc' } });
    const hasStanding =
      canManage ||
      instance.requesterId === callerId ||
      steps.some((step) => this.isEligibleForStep(step, callerId));
    if (!hasStanding) {
      throw new ForbiddenException('You have no standing on this workflow instance.');
    }

    const actions = await tx.workflowAction.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
    return { instance, steps, actions };
  }

  async actOnStep(
    tx: Prisma.TransactionClient,
    tenantId: string,
    instanceId: string,
    instanceStepId: string,
    actorUserId: string,
    body: WorkflowStepActionInput,
  ): Promise<WorkflowInstance> {
    const instance = await tx.workflowInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Workflow instance "${instanceId}" was not found.`);
    }
    if (TERMINAL_STATUSES.has(instance.status)) {
      throw new BadRequestException(`Workflow instance "${instanceId}" is already ${instance.status}.`);
    }

    const step = await tx.workflowInstanceStep.findUnique({ where: { id: instanceStepId } });
    if (!step || step.instanceId !== instanceId) {
      throw new NotFoundException(`Workflow instance step "${instanceStepId}" was not found on this instance.`);
    }
    if (step.status !== 'ACTIVE') {
      throw new BadRequestException(`Step "${step.name}" is ${step.status}, not awaiting action.`);
    }

    if (body.actionType === 'COMMENT') {
      const canComment =
        actorUserId === instance.requesterId ||
        this.isEligibleForStep(step, actorUserId) ||
        (await this.hasAnyEligibility(tx, instanceId, actorUserId));
      if (!canComment) {
        throw new ForbiddenException('You have no standing to comment on this workflow instance.');
      }
      await tx.workflowAction.create({
        data: { tenantId, instanceId, instanceStepId, actionType: 'COMMENT', actorUserId, comment: body.comment },
      });
      return instance;
    }

    if (!this.isEligibleForStep(step, actorUserId)) {
      throw new ForbiddenException(`You are not an eligible approver for step "${step.name}".`);
    }

    if (body.actionType === 'DELEGATE') {
      const delegate = await tx.user.findUnique({ where: { id: body.delegatedToUserId }, select: { id: true, status: true } });
      if (!delegate || delegate.status !== 'ACTIVE') {
        throw new BadRequestException('delegatedToUserId must be an active user in this tenant.');
      }
      await tx.workflowInstanceStep.update({ where: { id: step.id }, data: { delegatedToUserId: delegate.id } });
      await tx.workflowAction.create({
        data: { tenantId, instanceId, instanceStepId, actionType: 'DELEGATE', actorUserId, delegatedToUserId: delegate.id, comment: body.comment },
      });
      this.eventEmitter.emit(WORKFLOW_EVENTS.DELEGATED, {
        type: WORKFLOW_EVENTS.DELEGATED,
        tenantId,
        instanceId,
        instanceStepId: step.id,
        delegatedByUserId: actorUserId,
        delegatedToUserId: delegate.id,
      });
      return instance;
    }

    if (body.actionType === 'REJECT') {
      await tx.workflowInstanceStep.update({
        where: { id: step.id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedByUserId: actorUserId },
      });
      await tx.workflowAction.create({
        data: { tenantId, instanceId, instanceStepId, actionType: 'REJECT', actorUserId, comment: body.comment },
      });
      return this.finalize(tx, tenantId, instance, 'REJECTED');
    }

    // APPROVE
    await tx.workflowInstanceStep.update({
      where: { id: step.id },
      data: { status: 'APPROVED', decidedAt: new Date(), decidedByUserId: actorUserId },
    });
    await tx.workflowAction.create({
      data: { tenantId, instanceId, instanceStepId, actionType: 'APPROVE', actorUserId, comment: body.comment },
    });
    this.eventEmitter.emit(WORKFLOW_EVENTS.STEP_APPROVED, {
      type: WORKFLOW_EVENTS.STEP_APPROVED,
      tenantId,
      instanceId,
      instanceStepId: step.id,
      actorUserId,
    });

    const deEscalated =
      instance.status === 'ESCALATED' ? await tx.workflowInstance.update({ where: { id: instance.id }, data: { status: 'IN_STEP' } }) : instance;
    return this.checkGroupCompletionAndAdvance(tx, tenantId, deEscalated);
  }

  async cancelInstance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    instanceId: string,
    actorUserId: string,
    canManage: boolean,
  ): Promise<WorkflowInstance> {
    const instance = await tx.workflowInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Workflow instance "${instanceId}" was not found.`);
    }
    if (TERMINAL_STATUSES.has(instance.status)) {
      throw new BadRequestException(`Workflow instance "${instanceId}" is already ${instance.status}.`);
    }
    if (instance.requesterId !== actorUserId && !canManage) {
      throw new ForbiddenException('Only the requester (or workflow.manage) may cancel this instance.');
    }

    await tx.workflowAction.create({ data: { tenantId, instanceId, actionType: 'CANCEL', actorUserId } });
    return this.finalize(tx, tenantId, instance, 'CANCELED');
  }

  /** In-app filter over currently-ACTIVE steps (see /CLAUDE.md § Conventions → Workflow engine for the known scaling tradeoff this accepts for now). */
  async myPendingApprovals(tx: Prisma.TransactionClient, userId: string): Promise<WorkflowInstanceStep[]> {
    const activeSteps = await tx.workflowInstanceStep.findMany({ where: { status: 'ACTIVE' }, orderBy: { activatedAt: 'asc' } });
    return activeSteps.filter((step) => this.isEligibleForStep(step, userId));
  }

  private isEligibleForStep(step: WorkflowInstanceStep, userId: string): boolean {
    if (step.delegatedToUserId) {
      return step.delegatedToUserId === userId;
    }
    if (step.escalatedToUserId) {
      return step.escalatedToUserId === userId;
    }
    return (step.eligibleApproverIds as string[]).includes(userId);
  }

  private async hasAnyEligibility(tx: Prisma.TransactionClient, instanceId: string, userId: string): Promise<boolean> {
    const steps = await tx.workflowInstanceStep.findMany({ where: { instanceId } });
    return steps.some((step) => this.isEligibleForStep(step, userId));
  }

  /**
   * Activates the lowest-`order` group of still-`PENDING` (i.e. not
   * SKIPPED, not already activated) steps: resolves each step's
   * approvers, auto-approves any whose `autoApproveCondition` is true,
   * and marks the rest `ACTIVE` with a `dueAt` if the step escalates.
   * Recurses immediately if the WHOLE group auto-approved (so a
   * multi-step template where every applicable step auto-approves
   * resolves straight through to APPROVED in one call). No PENDING steps
   * left at all -> the instance is APPROVED.
   */
  private async activateNextGroup(tx: Prisma.TransactionClient, tenantId: string, instance: WorkflowInstance): Promise<WorkflowInstance> {
    const pendingSteps = await tx.workflowInstanceStep.findMany({
      where: { instanceId: instance.id, status: 'PENDING' },
      orderBy: { order: 'asc' },
    });
    if (pendingSteps.length === 0) {
      return this.finalize(tx, tenantId, instance, 'APPROVED');
    }

    const nextOrder = pendingSteps[0].order;
    const group = pendingSteps.filter((step) => step.order === nextOrder);
    const templateSteps = await tx.workflowStep.findMany({ where: { id: { in: group.map((step) => step.templateStepId) } } });
    const templateStepById = new Map(templateSteps.map((step) => [step.id, step]));
    const dataSnapshot = instance.dataSnapshot as Record<string, unknown>;

    for (const instanceStep of group) {
      const templateStep = templateStepById.get(instanceStep.templateStepId);
      /* istanbul ignore next -- templateStepById is populated from the same group's templateStepIds above */
      if (!templateStep) continue;

      const rule = approverRuleSchema.parse(templateStep.approverRule);
      const eligibleApproverIds = await this.approverResolver.resolve(tx, rule, {
        requesterId: instance.requesterId,
        dataSnapshot,
      });

      const autoApproveCondition = templateStep.autoApproveCondition
        ? workflowConditionSchema.parse(templateStep.autoApproveCondition)
        : null;
      const autoApproves = autoApproveCondition ? evaluateWorkflowCondition(autoApproveCondition, dataSnapshot) : false;
      const now = new Date();

      if (autoApproves) {
        await tx.workflowInstanceStep.update({
          where: { id: instanceStep.id },
          data: { status: 'APPROVED', eligibleApproverIds, activatedAt: now, decidedAt: now },
        });
        await tx.workflowAction.create({
          data: { tenantId, instanceId: instance.id, instanceStepId: instanceStep.id, actionType: 'AUTO_APPROVE' },
        });
        this.eventEmitter.emit(WORKFLOW_EVENTS.STEP_APPROVED, {
          type: WORKFLOW_EVENTS.STEP_APPROVED,
          tenantId,
          instanceId: instance.id,
          instanceStepId: instanceStep.id,
          actorUserId: null,
          auto: true,
        });
      } else {
        const dueAt = templateStep.escalationAfterMinutes
          ? new Date(now.getTime() + templateStep.escalationAfterMinutes * 60_000)
          : null;
        await tx.workflowInstanceStep.update({
          where: { id: instanceStep.id },
          data: { status: 'ACTIVE', eligibleApproverIds, activatedAt: now, dueAt },
        });
      }
    }

    const updatedInstance = await tx.workflowInstance.update({
      where: { id: instance.id },
      data: { status: 'IN_STEP', currentOrder: nextOrder },
    });

    return this.checkGroupCompletionAndAdvance(tx, tenantId, updatedInstance);
  }

  private async checkGroupCompletionAndAdvance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    if (TERMINAL_STATUSES.has(instance.status) || instance.currentOrder === null) {
      return instance;
    }
    const groupSteps = await tx.workflowInstanceStep.findMany({
      where: { instanceId: instance.id, order: instance.currentOrder },
    });
    const allApproved = groupSteps.every((step) => step.status === 'APPROVED');
    return allApproved ? this.activateNextGroup(tx, tenantId, instance) : instance;
  }

  /**
   * Terminates the instance. Deliberately does NOT rewrite the status of
   * any step still `ACTIVE` at this moment (a REJECT's parallel siblings,
   * or every step when CANCELED) — the instance's own terminal `status`
   * is authoritative and is what `actOnStep`'s terminal-instance guard
   * checks; a step frozen mid-flight stays exactly as it was for audit
   * ("this step never got a decision because the instance was
   * rejected/canceled elsewhere" is itself meaningful history, not a gap
   * to paper over).
   */
  private async finalize(
    tx: Prisma.TransactionClient,
    tenantId: string,
    instance: WorkflowInstance,
    status: 'APPROVED' | 'REJECTED' | 'CANCELED',
  ): Promise<WorkflowInstance> {
    const finalized = await tx.workflowInstance.update({
      where: { id: instance.id },
      data: { status, currentOrder: null, completedAt: new Date() },
    });

    const eventType = status === 'APPROVED' ? WORKFLOW_EVENTS.APPROVED : status === 'REJECTED' ? WORKFLOW_EVENTS.REJECTED : WORKFLOW_EVENTS.CANCELED;
    this.eventEmitter.emit(eventType, {
      type: eventType,
      tenantId,
      instanceId: finalized.id,
      entityType: finalized.entityType,
      entityId: finalized.entityId,
    });

    return finalized;
  }
}
