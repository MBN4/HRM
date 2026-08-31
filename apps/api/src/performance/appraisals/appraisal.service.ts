import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Appraisal, Prisma } from '@hrm/db';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { PERFORMANCE_APPRAISAL_ENTITY_TYPE } from '../performance.constants';

export type AppraisalDetail = Prisma.AppraisalGetPayload<{ include: { employee: true; assignments: true; reviews: true } }>;

export interface AppraisalListFilters {
  cycleId?: string;
  employeeId?: string;
  status?: string;
  branchId?: string;
}

const MAX_LIST_RESULTS = 200;

/**
 * The appraisal ("one employee's case within one cycle") orchestration —
 * see docs/conventions/performance.md. Owns NO approve/reject logic of its
 * own: `submitForApproval` starts a real 0.7 `WorkflowInstance` (THE RULE)
 * and this module's only other connection to the decision is
 * `AppraisalWorkflowEventsListener` reacting to `workflow.approved`/
 * `workflow.rejected`.
 */
@Injectable()
export class AppraisalService {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  async findById(
    tx: Prisma.TransactionClient,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<AppraisalDetail> {
    const row = await tx.appraisal.findUnique({ where: { id }, include: { employee: true, assignments: true, reviews: true } });
    if (!row) {
      throw new NotFoundException(`Appraisal "${id}" was not found.`);
    }
    const isSelf = row.employee.userId === callerUserId;
    if (!isSelf) {
      if (!canManageOthers || (allowedBranchIds && !allowedBranchIds.includes(row.employee.branchId))) {
        throw new NotFoundException(`Appraisal "${id}" was not found.`);
      }
    }
    return row;
  }

  async list(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: AppraisalListFilters,
  ): Promise<Appraisal[]> {
    const where: Prisma.AppraisalWhereInput = {};

    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      where.employeeId = own.id;
    } else {
      if (filters.branchId && allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      const employeeWhere: Prisma.EmployeeWhereInput = {};
      if (filters.branchId) {
        employeeWhere.branchId = filters.branchId;
      } else if (allowedBranchIds) {
        employeeWhere.branchId = { in: allowedBranchIds };
      }
      if (Object.keys(employeeWhere).length > 0) {
        where.employee = employeeWhere;
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.cycleId) {
      where.cycleId = filters.cycleId;
    }
    if (filters.status) {
      where.status = filters.status as Appraisal['status'];
    }

    return tx.appraisal.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  /**
   * Requires EVERY `ReviewAssignment` for this appraisal to be `SUBMITTED`
   * (an appraisal enrolled with zero assignments — e.g. no manager AND no
   * cycle-enabled peer/upward reviewers — can never be submitted; a
   * documented edge case, not silently allowed through with an empty
   * rating). `overallRating` is a simple, unweighted average across
   * submitted `Review.overallRating` rows — a documented simplification,
   * see docs/conventions/performance.md.
   */
  async submitForApproval(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, id: string): Promise<void> {
    const appraisal = await tx.appraisal.findUnique({ where: { id }, include: { employee: true } });
    if (!appraisal) {
      throw new NotFoundException(`Appraisal "${id}" was not found.`);
    }
    if (appraisal.status !== 'DRAFT' && appraisal.status !== 'IN_PROGRESS') {
      throw new ConflictException(`Appraisal "${id}" is "${appraisal.status}" and can no longer be submitted for approval.`);
    }
    if (!appraisal.employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account and cannot have an appraisal routed for sign-off (the workflow engine resolves approvers relative to a real requester user).',
      );
    }

    const assignments = await tx.reviewAssignment.findMany({ where: { appraisalId: id } });
    if (assignments.length === 0 || assignments.some((assignment) => assignment.status !== 'SUBMITTED')) {
      throw new ConflictException('Every review assignment for this appraisal must be SUBMITTED before it can be routed for sign-off.');
    }

    const reviews = await tx.review.findMany({ where: { appraisalId: id } });
    const overallRating = reviews.reduce((total, review) => total + review.overallRating, 0) / reviews.length;

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: appraisal.employee.userId,
      entityType: PERFORMANCE_APPRAISAL_ENTITY_TYPE,
      entityId: appraisal.id,
      dataSnapshot: {
        employeeId: appraisal.employeeId,
        branchId: appraisal.employee.branchId,
        departmentId: appraisal.employee.departmentId,
        cycleId: appraisal.cycleId,
        overallRating,
      },
    });

    await tx.appraisal.update({
      where: { id },
      data: { status: 'PENDING_SIGNOFF', overallRating, workflowInstanceId: instance.id, submittedForApprovalAt: new Date() },
    });
  }

  assertBranchAllowed(branchId: string, allowedBranchIds: string[] | null): void {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException('You are not permitted to act on appraisals for this branch.');
    }
  }
}
