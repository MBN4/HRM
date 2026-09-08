import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { BenefitEnrollment, Employee, Prisma } from '@hrm/db';
import type { CreateBenefitEnrollmentInput } from '@hrm/shared';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { BenefitPlanService } from './benefit-plan.service';
import { BENEFIT_ENROLLMENT_ENTITY_TYPE } from './benefits.constants';

/**
 * Enrollment lifecycle — see docs/conventions/benefits.md. Admin-assigned
 * (`benefits.manage`, any employee) or self-elected via ESS
 * (`benefits.enroll`, own employee record only, and only when the plan's
 * own `allowSelfElection` is true). A `requiresApproval` plan starts
 * `PENDING_APPROVAL` and flips to `ACTIVE` only once the REAL 0.7 workflow
 * approves it (`entityType: "BENEFIT_ENROLLMENT"`, THE RULE — see
 * `BenefitsWorkflowEventsListener`, this service owns zero bespoke
 * approve/reject logic); every other plan enrolls `ACTIVE` immediately.
 */
@Injectable()
export class BenefitEnrollmentService {
  constructor(
    private readonly plans: BenefitPlanService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async enroll(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    input: CreateBenefitEnrollmentInput,
  ): Promise<BenefitEnrollment> {
    const isSelfService = !input.employeeId;
    const employee = await this.resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, input.employeeId);
    const plan = await this.plans.requireActiveById(tx, tenantId, input.planId);

    if (isSelfService && !canManageOthers && !plan.allowSelfElection) {
      throw new ForbiddenException(`Benefit plan "${plan.name}" does not allow self-election — ask HR to enroll you.`);
    }

    let coverageTierId: string | null = null;
    if (plan.hasTiers) {
      if (!input.coverageTierId) {
        throw new BadRequestException(`Benefit plan "${plan.name}" requires a coverage tier.`);
      }
      const tier = plan.tiers.find((t) => t.id === input.coverageTierId);
      if (!tier) {
        throw new BadRequestException(`Coverage tier "${input.coverageTierId}" does not belong to plan "${plan.name}".`);
      }
      coverageTierId = tier.id;
    }

    const dependentIds: string[] = [];
    for (const dependentId of input.dependentIds) {
      const dependent = await tx.employeeDependent.findFirst({ where: { tenantId, id: dependentId, employeeId: employee.id } });
      if (!dependent) {
        throw new BadRequestException(`Dependent "${dependentId}" does not belong to this employee.`);
      }
      dependentIds.push(dependent.id);
    }

    const enrollment = await tx.benefitEnrollment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        planId: plan.id,
        coverageTierId,
        status: plan.requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        enrolledByUserId: callerUserId,
      },
    });

    if (dependentIds.length > 0) {
      await tx.benefitEnrollmentDependent.createMany({
        data: dependentIds.map((employeeDependentId) => ({ tenantId, enrollmentId: enrollment.id, employeeDependentId })),
      });
    }

    if (plan.requiresApproval) {
      if (!employee.userId) {
        throw new BadRequestException(
          'This employee has no linked user account and cannot enroll in an approval-gated plan (the workflow engine resolves approvers relative to a real requester user).',
        );
      }
      const instance = await this.workflowEngine.startInstance(tx, tenantId, {
        requesterId: employee.userId,
        entityType: BENEFIT_ENROLLMENT_ENTITY_TYPE,
        entityId: enrollment.id,
        dataSnapshot: { employeeId: employee.id, branchId: employee.branchId, planId: plan.id, planName: plan.name },
      });
      return tx.benefitEnrollment.update({ where: { id: enrollment.id }, data: { workflowInstanceId: instance.id } });
    }

    return enrollment;
  }

  async cancel(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<BenefitEnrollment> {
    const enrollment = await this.requireOwned(tx, tenantId, id, callerUserId, canManageOthers);
    if (enrollment.status === 'CANCELLED') {
      return enrollment;
    }
    return tx.benefitEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'CANCELLED', effectiveTo: enrollment.effectiveTo ?? new Date() },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: { employeeId?: string; planId?: string; status?: string },
  ): Promise<(BenefitEnrollment & { dependents: { employeeDependentId: string }[] })[]> {
    const where: Prisma.BenefitEnrollmentWhereInput = { tenantId };
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { id: true } });
      where.employeeId = own?.id ?? '__none__';
    } else if (filters.employeeId) {
      where.employeeId = filters.employeeId;
    } else if (allowedBranchIds) {
      where.employee = { branchId: { in: allowedBranchIds } };
    }
    if (filters.planId) {
      where.planId = filters.planId;
    }
    if (filters.status) {
      where.status = filters.status as BenefitEnrollment['status'];
    }
    return tx.benefitEnrollment.findMany({ where, include: { dependents: true }, orderBy: { createdAt: 'desc' } });
  }

  async findById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<BenefitEnrollment & { dependents: { employeeDependentId: string }[] }> {
    return this.requireOwned(tx, tenantId, id, callerUserId, canManageOthers, allowedBranchIds);
  }

  private async requireOwned(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null = null,
  ): Promise<BenefitEnrollment & { dependents: { employeeDependentId: string }[] }> {
    const enrollment = await tx.benefitEnrollment.findFirst({ where: { tenantId, id }, include: { dependents: true, employee: true } });
    if (!enrollment) {
      throw new NotFoundException(`Benefit enrollment "${id}" was not found.`);
    }
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { id: true } });
      if (!own || own.id !== enrollment.employeeId) {
        throw new NotFoundException(`Benefit enrollment "${id}" was not found.`);
      }
    } else if (allowedBranchIds && !allowedBranchIds.includes(enrollment.employee.branchId)) {
      throw new NotFoundException(`Benefit enrollment "${id}" was not found.`);
    }
    return enrollment;
  }

  private async resolveTargetEmployee(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    explicitEmployeeId?: string,
  ): Promise<Employee> {
    if (!explicitEmployeeId) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId } });
      if (!own) {
        throw new NotFoundException('You have no employee profile.');
      }
      return own;
    }

    const employee = await tx.employee.findUnique({ where: { id: explicitEmployeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
    }
    if (employee.userId !== callerUserId) {
      if (!canManageOthers) {
        throw new ForbiddenException("benefits.manage is required to enroll another employee.");
      }
      if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
        throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
      }
    }
    return employee;
  }
}
