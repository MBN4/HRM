import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { resolvePayrollPackConfig } from '../payroll-pack.util';
import { PAYROLL_RUN_ENTITY_TYPE } from '../payroll.constants';
import { PayrollRunQueueService } from './payroll-run-queue.service';

/**
 * Payroll run ORCHESTRATION — creation/lifecycle, never the calculation
 * itself (see `PayrollEngineService`/`PayrollRunProcessor`). Deliberately
 * owns NO approve/reject logic — `submitForApproval` starts a real 0.7
 * `WorkflowInstance` and this module's only other connection to the
 * decision is `PayrollWorkflowEventsListener` reacting to
 * `workflow.approved` (THE RULE — see docs/conventions/workflow.md).
 */
@Injectable()
export class PayrollRunService {
  constructor(
    private readonly workflowEngine: WorkflowEngineService,
    private readonly queue: PayrollRunQueueService,
  ) {}

  /**
   * `settlement` (step 2.3, additive) creates a `FINAL_SETTLEMENT` run for
   * exactly one (already possibly non-`ACTIVE`) employee instead of the
   * branch's whole `ACTIVE` roster — see the `PayrollRunType` doc comment
   * in schema.prisma and docs/conventions/recruitment-lifecycle.md for the
   * full "why". Everything else about run creation (pack-driven
   * `payrollMode`/`currencyCode` resolution) is IDENTICAL for both kinds.
   */
  async createRun(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    branchId: string,
    periodYear: number,
    periodMonth: number,
    settlement?: { employeeId: string },
  ) {
    const pack = await resolvePayrollPackConfig(tx, tenantId, branchId);

    return tx.payrollRun.create({
      data: {
        tenantId,
        branchId,
        periodYear,
        periodMonth,
        status: 'DRAFT',
        payrollMode: pack.config.payrollMode,
        currencyCode: pack.config.locale.currencyCode,
        createdByUserId: callerUserId,
        runType: settlement ? 'FINAL_SETTLEMENT' : 'REGULAR',
        settlementEmployeeId: settlement?.employeeId ?? null,
      },
    });
  }

  async calculate(tx: Prisma.TransactionClient, tenantId: string, runId: string): Promise<void> {
    const run = await this.requireRun(tx, runId);
    if (run.status !== 'DRAFT' && run.status !== 'CALCULATED') {
      throw new ConflictException(`Payroll run "${runId}" is "${run.status}" and can no longer be (re)calculated.`);
    }
    await this.queue.enqueueCalculate(tenantId, runId);
  }

  async submitForApproval(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, runId: string): Promise<void> {
    const run = await this.requireRun(tx, runId);
    if (run.status !== 'CALCULATED') {
      throw new ConflictException(`Payroll run "${runId}" must be fully CALCULATED before it can be submitted for approval (is "${run.status}").`);
    }
    if (run.workflowInstanceId) {
      throw new ConflictException(`Payroll run "${runId}" already has an approval in progress.`);
    }

    const lineCount = await tx.payrollRunLine.count({ where: { payrollRunId: runId } });
    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: callerUserId,
      entityType: PAYROLL_RUN_ENTITY_TYPE,
      entityId: run.id,
      dataSnapshot: {
        branchId: run.branchId,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
        totalGross: run.totalGross.toString(),
        totalNet: run.totalNet.toString(),
        employeeCount: lineCount,
      },
    });

    await tx.payrollRun.update({ where: { id: run.id }, data: { workflowInstanceId: instance.id } });
  }

  async finalize(tx: Prisma.TransactionClient, runId: string): Promise<void> {
    const run = await this.requireRun(tx, runId);
    if (run.status !== 'APPROVED') {
      throw new ConflictException(`Payroll run "${runId}" must be APPROVED before it can be finalized (is "${run.status}").`);
    }
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
  }

  async markPaid(tx: Prisma.TransactionClient, runId: string): Promise<void> {
    const run = await this.requireRun(tx, runId);
    if (run.status !== 'FINALIZED') {
      throw new ConflictException(`Payroll run "${runId}" must be FINALIZED before it can be marked PAID (is "${run.status}").`);
    }
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'PAID', paidAt: new Date() } });
  }

  async requireRun(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.payrollRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException(`Payroll run "${runId}" was not found.`);
    }
    return run;
  }

  /** `null` = unrestricted; a restricted caller may only act on runs for their allowed branches — same two-layer shape branch scoping already establishes elsewhere. */
  assertBranchAllowed(branchId: string, allowedBranchIds: string[] | null): void {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException('You are not permitted to act on payroll runs for this branch.');
    }
  }

}
