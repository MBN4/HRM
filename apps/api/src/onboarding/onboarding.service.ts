import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ChecklistTaskInstance, OnboardingProcess, Prisma } from '@hrm/db';
import type { CompleteOnboardingInput } from '@hrm/shared';
import { EmployeeService } from '../employees/employee.service';
import { EmployeeResponseDto } from '../employees/employee-response.dto';
import { ChecklistService } from '../checklists/checklist.service';
import { ONBOARDING_PROCESS_TYPE } from './onboarding.constants';

/**
 * The candidate -> Employee BRIDGE — see
 * docs/conventions/recruitment-lifecycle.md. `start` is idempotent against
 * a redelivered `recruitment.offer_accepted` event (an existing process
 * for the same offer is returned as-is, never duplicated).
 * `createEmployee` is the ONE method that calls the REAL, UNMODIFIED 1.1
 * `EmployeeService.create` — every required-field/branch-scoping rule
 * that already applies to `POST /employees` applies here with ZERO new
 * validation logic. The onboarding CHECKLIST is deliberately instantiated
 * HERE, immediately after the Employee row exists (not at `start`) — a
 * `MANAGER`-rule checklist task has no `Employee.managerId` to resolve
 * against until the Employee itself exists.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly employees: EmployeeService,
    private readonly checklists: ChecklistService,
  ) {}

  async start(tx: Prisma.TransactionClient, tenantId: string, offerId: string, candidateId: string): Promise<OnboardingProcess> {
    const existing = await tx.onboardingProcess.findUnique({ where: { tenantId_offerId: { tenantId, offerId } } });
    if (existing) {
      return existing;
    }
    return tx.onboardingProcess.create({ data: { tenantId, offerId, candidateId } });
  }

  async createEmployee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    allowedBranchIds: string[] | null,
    input: CompleteOnboardingInput,
    checklistTemplateName?: string,
  ): Promise<EmployeeResponseDto> {
    const process = await this.requireProcess(tx, id);
    if (process.status !== 'IN_PROGRESS') {
      throw new ConflictException(`Onboarding process "${id}" is "${process.status}" — an Employee cannot be (re)created for it.`);
    }
    if (process.employeeId) {
      throw new ConflictException(`Onboarding process "${id}" already created an Employee.`);
    }

    const offer = await tx.offer.findUniqueOrThrow({ where: { id: process.offerId } });
    const candidate = await tx.candidate.findUniqueOrThrow({ where: { id: process.candidateId } });

    const employee = await this.employees.create(
      tx,
      tenantId,
      {
        employeeCode: input.employeeCode,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        personalEmail: candidate.email,
        phone: candidate.phone ?? undefined,
        branchId: offer.branchId,
        departmentId: input.departmentId ?? offer.departmentId ?? undefined,
        designationId: input.designationId ?? offer.designationId ?? undefined,
        employmentType: offer.employmentType,
        joinDate: input.joinDate ?? offer.proposedJoinDate,
        managerId: input.managerId,
        statutoryFields: input.statutoryFields,
        bankDetails: input.bankDetails,
        compensation: input.compensation ?? { baseSalary: Number(offer.proposedSalary), salaryCurrency: offer.salaryCurrency },
        dependents: input.dependents,
        emergencyContacts: input.emergencyContacts,
        customFields: input.customFields,
      },
      allowedBranchIds,
    );

    await tx.onboardingProcess.update({
      where: { id },
      data: { employeeId: employee.id, status: 'COMPLETED', completedAt: new Date() },
    });

    await this.checklists.instantiate(tx, tenantId, ONBOARDING_PROCESS_TYPE, id, employee.id, checklistTemplateName);

    return employee;
  }

  async listTasks(tx: Prisma.TransactionClient, id: string): Promise<ChecklistTaskInstance[]> {
    await this.requireProcess(tx, id);
    return this.checklists.listForProcess(tx, ONBOARDING_PROCESS_TYPE, id);
  }

  async list(tx: Prisma.TransactionClient): Promise<OnboardingProcess[]> {
    return tx.onboardingProcess.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<OnboardingProcess> {
    return this.requireProcess(tx, id);
  }

  private async requireProcess(tx: Prisma.TransactionClient, id: string): Promise<OnboardingProcess> {
    const process = await tx.onboardingProcess.findUnique({ where: { id } });
    if (!process) {
      throw new NotFoundException(`Onboarding process "${id}" was not found.`);
    }
    return process;
  }
}
