import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ChecklistProcessType, ChecklistTaskInstance, Prisma } from '@hrm/db';
import { checklistTaskDefinitionSchema } from '@hrm/shared';
import { resolveChecklistAssignee } from './checklist-assignee-resolver.util';

/**
 * The checklist mini-engine's INSTANTIATION + COMPLETION side — see
 * docs/conventions/recruitment-lifecycle.md. Deliberately generic over
 * `processType`/`processId` (POLYMORPHIC, no FK — the same
 * `WorkflowInstance.entityType`/`entityId` pattern) so Onboarding and
 * Offboarding share ONE implementation rather than two near-identical
 * ones. Neither `OnboardingProcess` nor `OffboardingProcess` is a hard
 * dependency of this module — it only ever reads/writes
 * `ChecklistTaskInstance` rows keyed by the caller-supplied
 * `(processType, processId)`.
 */
@Injectable()
export class ChecklistService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Instantiates every task in the resolved template as a
   * `ChecklistTaskInstance`, resolving each task's `assigneeRule` ONCE
   * against `employeeId`'s context (a later org-chart change never
   * rewrites an already-instantiated task — see the schema's own doc
   * comment). Emits `checklist.task_assigned` per task that resolved to a
   * real assignee (an unresolved rule, e.g. `MANAGER` for an employee with
   * none, simply creates an unassigned task — a documented gap, not an
   * error).
   */
  async instantiate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    processType: ChecklistProcessType,
    processId: string,
    employeeId: string,
    templateName?: string,
  ): Promise<ChecklistTaskInstance[]> {
    const template = templateName
      ? await tx.checklistTemplate.findUnique({ where: { tenantId_processType_name: { tenantId, processType, name: templateName } } })
      : await tx.checklistTemplate.findFirst({ where: { tenantId, processType, isActive: true }, orderBy: { createdAt: 'asc' } });

    if (!template || !template.isActive) {
      throw new NotFoundException(
        `No active ${processType} checklist template is configured${templateName ? ` named "${templateName}"` : ''} for this tenant.`,
      );
    }

    const tasks = checklistTaskDefinitionSchema.array().parse(template.tasks);
    const created: ChecklistTaskInstance[] = [];

    for (const task of tasks) {
      const assigneeUserId = await resolveChecklistAssignee(tx, tenantId, task.assigneeRule, employeeId);
      const row = await tx.checklistTaskInstance.create({
        data: {
          tenantId,
          processType,
          processId,
          key: task.key,
          title: task.title,
          category: task.category,
          assigneeUserId,
          requiresDocument: task.requiresDocument,
        },
      });
      created.push(row);

      if (assigneeUserId) {
        this.eventEmitter.emit('checklist.task_assigned', {
          type: 'checklist.task_assigned',
          tenantId,
          taskId: row.id,
          assigneeUserId,
          processType,
          processId,
        });
      }
    }

    return created;
  }

  async listForProcess(tx: Prisma.TransactionClient, processType: ChecklistProcessType, processId: string): Promise<ChecklistTaskInstance[]> {
    return tx.checklistTaskInstance.findMany({ where: { processType, processId }, orderBy: { createdAt: 'asc' } });
  }

  async myTasks(tx: Prisma.TransactionClient, callerUserId: string): Promise<ChecklistTaskInstance[]> {
    return tx.checklistTaskInstance.findMany({
      where: { assigneeUserId: callerUserId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** `true` only when the process has at least one task AND every task is `COMPLETED` — an empty checklist is never treated as "done" by a caller gating on this (see `OffboardingService.complete`). */
  async allCompleted(tx: Prisma.TransactionClient, processType: ChecklistProcessType, processId: string): Promise<boolean> {
    const tasks = await this.listForProcess(tx, processType, processId);
    return tasks.length > 0 && tasks.every((task) => task.status === 'COMPLETED');
  }

  async complete(
    tx: Prisma.TransactionClient,
    taskId: string,
    callerUserId: string,
    canManageOverride: boolean,
    documentStorageKey?: string,
  ): Promise<ChecklistTaskInstance> {
    const task = await tx.checklistTaskInstance.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Checklist task "${taskId}" was not found.`);
    }
    if (task.status !== 'PENDING') {
      throw new BadRequestException(`Checklist task "${taskId}" is already ${task.status}.`);
    }
    if (task.assigneeUserId !== callerUserId && !canManageOverride) {
      throw new ForbiddenException('You may only complete a checklist task assigned to you.');
    }
    if (task.requiresDocument && !documentStorageKey) {
      throw new BadRequestException(`Checklist task "${task.title}" requires a document to be uploaded to complete it.`);
    }

    return tx.checklistTaskInstance.update({
      where: { id: taskId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completedByUserId: callerUserId,
        ...(documentStorageKey ? { documentStorageKey } : {}),
      },
    });
  }
}
