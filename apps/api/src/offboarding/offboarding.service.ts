import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, OffboardingProcess, Prisma } from '@hrm/db';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { EmployeeService } from '../employees/employee.service';
import { ChecklistService } from '../checklists/checklist.service';
import { PayrollRunService } from '../payroll/runs/payroll-run.service';
import { TokenService } from '../auth/token.service';
import { OFFBOARDING_CHECKLIST_PROCESS_TYPE, OFFBOARDING_PROCESS_ENTITY_TYPE } from './offboarding.constants';

export interface InitiateOffboardingInput {
  employeeId: string;
  reason: 'RESIGNATION' | 'TERMINATION';
  lastWorkingDate: Date;
}

/**
 * The clean EXIT bridge — see docs/conventions/recruitment-lifecycle.md.
 * Owns NO approve/reject logic of its own (THE RULE): `initiate` starts a
 * real 0.7 `WorkflowInstance`; `OffboardingWorkflowEventsListener` reacts
 * to the decision. `complete` is the ONE action that hands off to Payroll
 * (2.1, via the additive `PayrollRun.runType` seam) and Auth (0.4, via
 * `TokenService.revokeAllForUser`) — both REUSED, neither reimplemented.
 */
@Injectable()
export class OffboardingService {
  constructor(
    private readonly workflowEngine: WorkflowEngineService,
    private readonly employees: EmployeeService,
    private readonly checklists: ChecklistService,
    private readonly payrollRuns: PayrollRunService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * `requesterId` is the DEPARTING employee's own linked `User.id` —
   * deliberately, the SAME "requester = the subject, so a `MANAGER`
   * approver rule resolves to THEIR manager" reuse Leave/Performance
   * already establish for their own submissions (see
   * docs/conventions/leave.md, docs/conventions/performance.md) — not a
   * literal claim that the employee "requested" their own termination.
   * Requires the employee to have a linked `User` (the same "the workflow
   * engine resolves approvers relative to a real requester user"
   * constraint those modules already enforce).
   */
  async initiate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    allowedBranchIds: string[] | null,
    input: InitiateOffboardingInput,
  ): Promise<OffboardingProcess> {
    const employee = await this.requireEmployeeInScope(tx, input.employeeId, allowedBranchIds);
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account and cannot be routed for offboarding sign-off (the workflow engine resolves approvers relative to a real requester user).',
      );
    }

    const process = await tx.offboardingProcess.create({
      data: {
        tenantId,
        employeeId: employee.id,
        reason: input.reason,
        lastWorkingDate: input.lastWorkingDate,
        initiatedByUserId: callerUserId,
      },
    });

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: employee.userId,
      entityType: OFFBOARDING_PROCESS_ENTITY_TYPE,
      entityId: process.id,
      dataSnapshot: {
        employeeId: employee.id,
        branchId: employee.branchId,
        reason: input.reason,
        lastWorkingDate: input.lastWorkingDate.toISOString(),
      },
    });

    return tx.offboardingProcess.update({ where: { id: process.id }, data: { workflowInstanceId: instance.id } });
  }

  /** Called by `OffboardingWorkflowEventsListener` once the workflow engine reaches `APPROVED` — instantiates the tenant's OFFBOARDING clearance checklist against the ALREADY-EXISTING employee. */
  async instantiateChecklist(tx: Prisma.TransactionClient, tenantId: string, process: OffboardingProcess, templateName?: string): Promise<void> {
    await this.checklists.instantiate(tx, tenantId, OFFBOARDING_CHECKLIST_PROCESS_TYPE, process.id, process.employeeId, templateName);
  }

  /**
   * Gated on every clearance task being `COMPLETED` (an offboarding
   * process with zero tasks can never complete — see
   * `ChecklistService.allCompleted`) — the same "every assignment
   * SUBMITTED before sign-off" gate `AppraisalService.submitForApproval`
   * already establishes. Performs, in order: (1) the REAL Employee status
   * transition (1.1's `EmployeeService.update`, which itself already
   * captures `terminatedAt`); (2) a REAL, UNMODIFIED Payroll
   * `FINAL_SETTLEMENT` run, created + calculated via the existing 2.1
   * lifecycle; (3) REAL access revocation (0.4's `TokenService.
   * revokeAllForUser` + `User.status = DISABLED`).
   */
  async complete(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    allowedBranchIds: string[] | null,
    id: string,
  ): Promise<OffboardingProcess> {
    const process = await this.requireProcess(tx, id);
    if (process.status !== 'APPROVED') {
      throw new ConflictException(`Offboarding process "${id}" must be APPROVED before it can be completed (is "${process.status}").`);
    }
    const allDone = await this.checklists.allCompleted(tx, OFFBOARDING_CHECKLIST_PROCESS_TYPE, id);
    if (!allDone) {
      throw new ConflictException('Every clearance checklist task must be COMPLETED before offboarding can be completed.');
    }

    const employee = await this.requireEmployeeInScope(tx, process.employeeId, allowedBranchIds);

    await this.employees.update(tx, tenantId, employee.id, { status: 'TERMINATED' }, allowedBranchIds);

    const settlementDate = process.lastWorkingDate;
    const run = await this.payrollRuns.createRun(
      tx,
      tenantId,
      callerUserId,
      employee.branchId,
      settlementDate.getUTCFullYear(),
      settlementDate.getUTCMonth() + 1,
      { employeeId: employee.id },
    );
    await this.payrollRuns.calculate(tx, tenantId, run.id);

    if (employee.userId) {
      await this.tokens.revokeAllForUser(tenantId, employee.userId);
      await tx.user.update({ where: { id: employee.userId }, data: { status: 'DISABLED' } });
    }

    return tx.offboardingProcess.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date(), settlementPayrollRunId: run.id },
    });
  }

  async listTasks(tx: Prisma.TransactionClient, id: string) {
    await this.requireProcess(tx, id);
    return this.checklists.listForProcess(tx, OFFBOARDING_CHECKLIST_PROCESS_TYPE, id);
  }

  async list(tx: Prisma.TransactionClient, allowedBranchIds: string[] | null): Promise<OffboardingProcess[]> {
    const where: Prisma.OffboardingProcessWhereInput = {};
    if (allowedBranchIds) {
      where.employee = { branchId: { in: allowedBranchIds } };
    }
    return tx.offboardingProcess.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findById(tx: Prisma.TransactionClient, id: string, allowedBranchIds: string[] | null): Promise<OffboardingProcess> {
    const process = await this.requireProcess(tx, id);
    await this.requireEmployeeInScope(tx, process.employeeId, allowedBranchIds);
    return process;
  }

  private async requireProcess(tx: Prisma.TransactionClient, id: string): Promise<OffboardingProcess> {
    const process = await tx.offboardingProcess.findUnique({ where: { id } });
    if (!process) {
      throw new NotFoundException(`Offboarding process "${id}" was not found.`);
    }
    return process;
  }

  private async requireEmployeeInScope(tx: Prisma.TransactionClient, employeeId: string, allowedBranchIds: string[] | null): Promise<Employee> {
    const employee = await tx.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
      throw new ForbiddenException('You are not permitted to act on offboarding for this branch.');
    }
    return employee;
  }
}
