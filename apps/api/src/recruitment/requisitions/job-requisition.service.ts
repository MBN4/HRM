import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { JobRequisition, Prisma } from '@hrm/db';
import type { CreateJobRequisitionInput } from '@hrm/shared';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { JOB_REQUISITION_ENTITY_TYPE, MAX_LIST_RESULTS } from '../recruitment.constants';

export interface JobRequisitionListFilters {
  status?: string;
  branchId?: string;
}

/**
 * Job requisitions — see docs/conventions/recruitment-lifecycle.md. Owns NO
 * approve/reject logic of its own: `submitForApproval` starts a real 0.7
 * `WorkflowInstance` (THE RULE) and this service's only other connection
 * to the decision is `JobRequisitionWorkflowEventsListener` reacting to
 * `workflow.approved`/`workflow.rejected`.
 */
@Injectable()
export class JobRequisitionService {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    allowedBranchIds: string[] | null,
    input: CreateJobRequisitionInput,
  ): Promise<JobRequisition> {
    this.assertBranchAllowed(input.branchId, allowedBranchIds);
    return tx.jobRequisition.create({
      data: {
        tenantId,
        title: input.title,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        employmentType: input.employmentType,
        headcount: input.headcount,
        justification: input.justification ?? null,
        createdByUserId: callerUserId,
      },
    });
  }

  async submitForApproval(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, id: string): Promise<void> {
    const requisition = await this.requireRequisition(tx, id);
    if (requisition.status !== 'DRAFT') {
      throw new ConflictException(`Job requisition "${id}" is "${requisition.status}" and can no longer be submitted for approval.`);
    }

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: callerUserId,
      entityType: JOB_REQUISITION_ENTITY_TYPE,
      entityId: requisition.id,
      dataSnapshot: {
        branchId: requisition.branchId,
        departmentId: requisition.departmentId,
        headcount: requisition.headcount,
        employmentType: requisition.employmentType,
      },
    });

    await tx.jobRequisition.update({ where: { id }, data: { status: 'PENDING_APPROVAL', workflowInstanceId: instance.id } });
  }

  async close(tx: Prisma.TransactionClient, id: string): Promise<JobRequisition> {
    const requisition = await this.requireRequisition(tx, id);
    if (requisition.status !== 'APPROVED') {
      throw new ConflictException(`Job requisition "${id}" must be APPROVED before it can be closed (is "${requisition.status}").`);
    }
    return tx.jobRequisition.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
  }

  async list(tx: Prisma.TransactionClient, allowedBranchIds: string[] | null, filters: JobRequisitionListFilters): Promise<JobRequisition[]> {
    const where: Prisma.JobRequisitionWhereInput = {};
    if (filters.branchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      where.branchId = filters.branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    if (filters.status) {
      where.status = filters.status as JobRequisition['status'];
    }
    return tx.jobRequisition.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  async findById(tx: Prisma.TransactionClient, id: string, allowedBranchIds: string[] | null): Promise<JobRequisition> {
    const requisition = await this.requireRequisition(tx, id);
    if (allowedBranchIds && !allowedBranchIds.includes(requisition.branchId)) {
      throw new NotFoundException(`Job requisition "${id}" was not found.`);
    }
    return requisition;
  }

  async requireRequisition(tx: Prisma.TransactionClient, id: string): Promise<JobRequisition> {
    const requisition = await tx.jobRequisition.findUnique({ where: { id } });
    if (!requisition) {
      throw new NotFoundException(`Job requisition "${id}" was not found.`);
    }
    return requisition;
  }

  assertBranchAllowed(branchId: string, allowedBranchIds: string[] | null): void {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException('You are not permitted to act on job requisitions for this branch.');
    }
  }
}
