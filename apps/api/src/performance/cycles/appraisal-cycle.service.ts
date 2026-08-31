import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppraisalCycle, Prisma } from '@hrm/db';
import type { CreateAppraisalCycleInput } from '@hrm/shared';
import { RatingScaleService } from '../rating-scales/rating-scale.service';
import { resolveAutoReviewers } from '../reviews/reviewer-resolver.util';

/**
 * Cycle lifecycle + ENROLLMENT — see docs/conventions/performance.md.
 * `open` is the one place eligibility (`eligibleBranchIds`/
 * `eligibleDepartmentIds`, empty = every branch/department) turns into real
 * `Appraisal` + `ReviewAssignment` rows, one per eligible `ACTIVE` employee.
 * Cheap and synchronous (no BullMQ queue, unlike Payroll's per-employee
 * salary computation): enrollment is a handful of inserts per employee, not
 * a country-pack-driven calculation, so there is no heavy per-employee work
 * to move off the request's own transaction.
 */
@Injectable()
export class AppraisalCycleService {
  constructor(
    private readonly ratingScales: RatingScaleService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(tx: Prisma.TransactionClient, tenantId: string, input: CreateAppraisalCycleInput): Promise<AppraisalCycle> {
    const scale = await this.ratingScales.requireByKey(tx, tenantId, input.ratingScaleKey);
    return tx.appraisalCycle.create({
      data: {
        tenantId,
        name: input.name,
        cycleType: input.cycleType,
        startDate: input.startDate,
        endDate: input.endDate,
        ratingScaleId: scale.id,
        enabledReviewTypes: input.enabledReviewTypes as Prisma.InputJsonValue,
        eligibleBranchIds: input.eligibleBranchIds as Prisma.InputJsonValue,
        eligibleDepartmentIds: input.eligibleDepartmentIds as Prisma.InputJsonValue,
      },
    });
  }

  async open(tx: Prisma.TransactionClient, tenantId: string, cycleId: string): Promise<AppraisalCycle> {
    const cycle = await this.requireCycle(tx, cycleId);
    if (cycle.status !== 'DRAFT') {
      throw new ConflictException(`Appraisal cycle "${cycleId}" is "${cycle.status}" and can no longer be opened.`);
    }

    const enabledReviewTypes = new Set(cycle.enabledReviewTypes as string[]);
    const eligibleBranchIds = cycle.eligibleBranchIds as string[];
    const eligibleDepartmentIds = cycle.eligibleDepartmentIds as string[];

    const where: Prisma.EmployeeWhereInput = { status: 'ACTIVE' };
    if (eligibleBranchIds.length > 0) {
      where.branchId = { in: eligibleBranchIds };
    }
    if (eligibleDepartmentIds.length > 0) {
      where.departmentId = { in: eligibleDepartmentIds };
    }
    const employees = await tx.employee.findMany({ where });

    for (const employee of employees) {
      const appraisal = await tx.appraisal.create({ data: { tenantId, cycleId, employeeId: employee.id } });
      const autoReviewers = await resolveAutoReviewers(tx, employee);
      const applicable = autoReviewers.filter((assignment) => enabledReviewTypes.has(assignment.reviewType));
      for (const assignment of applicable) {
        const created = await tx.reviewAssignment.create({
          data: { tenantId, appraisalId: appraisal.id, reviewType: assignment.reviewType, reviewerId: assignment.reviewerId },
        });
        await this.emitReviewDue(tx, tenantId, created.id, assignment.reviewerId);
      }
    }

    const opened = await tx.appraisalCycle.update({ where: { id: cycleId }, data: { status: 'OPEN', openedAt: new Date() } });
    this.eventEmitter.emit('performance.cycle_opened', { type: 'performance.cycle_opened', tenantId, cycleId });
    return opened;
  }

  async close(tx: Prisma.TransactionClient, cycleId: string): Promise<AppraisalCycle> {
    const cycle = await this.requireCycle(tx, cycleId);
    if (cycle.status !== 'OPEN') {
      throw new ConflictException(`Appraisal cycle "${cycleId}" is "${cycle.status}" and cannot be closed.`);
    }
    return tx.appraisalCycle.update({ where: { id: cycleId }, data: { status: 'CLOSED', closedAt: new Date() } });
  }

  async list(tx: Prisma.TransactionClient): Promise<AppraisalCycle[]> {
    return tx.appraisalCycle.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async requireCycle(tx: Prisma.TransactionClient, cycleId: string): Promise<AppraisalCycle> {
    const cycle = await tx.appraisalCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new NotFoundException(`Appraisal cycle "${cycleId}" was not found.`);
    }
    return cycle;
  }

  /** No linked `User` (e.g. a bulk-imported, not-yet-provisioned employee) = no notification — a legitimate no-op, same posture `PayslipService`'s own event-emission takes. */
  async emitReviewDue(tx: Prisma.TransactionClient, tenantId: string, assignmentId: string, reviewerEmployeeId: string): Promise<void> {
    const reviewer = await tx.employee.findUnique({ where: { id: reviewerEmployeeId }, select: { userId: true } });
    if (!reviewer?.userId) {
      return;
    }
    this.eventEmitter.emit('performance.review_due', {
      type: 'performance.review_due',
      tenantId,
      assignmentId,
      reviewerUserId: reviewer.userId,
    });
  }
}

export function assertEligibleReviewType(enabledReviewTypes: unknown, reviewType: string): void {
  if (!(enabledReviewTypes as string[]).includes(reviewType)) {
    throw new BadRequestException(`Review type "${reviewType}" is not enabled for this cycle.`);
  }
}
