import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { Prisma as PrismaNS, withTenantContext } from '@hrm/db';
import { PAYROLL_RUN_QUEUE } from '../../queue/queue.constants';
import { IdempotencyService } from '../../resilience/idempotency/idempotency.service';
import { resolvePayrollPackConfig, ResolvedPayrollPack } from '../payroll-pack.util';
import { PayrollEngineService } from '../engine/payroll-engine.service';
import { PAYROLL_PROVIDER_ADAPTER, PayrollProviderAdapter } from '../delegate/payroll-provider.interface';
import { MultiCurrencyRollupService } from './multi-currency-rollup.service';
import type { PayrollRunJobData } from './payroll-run-queue.service';

const IDEMPOTENCY_SCOPE = 'payroll-run';

/**
 * The run-calculation job's WORKER side — see docs/conventions/payroll.md.
 * Context-less (no `TenantContextService`), same posture every Phase 1
 * processor already takes. THE RESUMABILITY MECHANISM: any employee that
 * already has a `COMPUTED` `PayrollRunLine` for this run is skipped
 * entirely on a re-run — a plain query against this table's own `status`
 * column, no separate checkpoint table needed. THE IDEMPOTENCY MECHANISM,
 * two independent layers (this project's "no single layer trusted alone"
 * posture): (1) `IdempotencyService` (0.10, Redis) claims
 * `<tenantId>:<runId>:<employeeId>` before doing any work; (2)
 * `PayrollRunLine`'s own `@@unique([tenantId, payrollRunId, employeeId])`
 * is a DATABASE-layer backstop — `P2002` on that `create()` is treated as
 * "already done," not an error. A single employee's failure (e.g. a
 * corrupted encrypted salary value) is caught and recorded as a `FAILED`
 * line WITHOUT aborting the rest of the run — every other employee still
 * gets processed, and a later `calculate` call retries only the failed
 * one(s), never reprocessing anyone already `COMPUTED`.
 */
@Processor(PAYROLL_RUN_QUEUE)
export class PayrollRunProcessor extends WorkerHost {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly engine: PayrollEngineService,
    private readonly rollup: MultiCurrencyRollupService,
    @Inject(PAYROLL_PROVIDER_ADAPTER) private readonly delegateAdapter: PayrollProviderAdapter,
  ) {
    super();
  }

  /**
   * Deliberately does NOT hold one transaction open across the whole
   * per-employee loop — see `LeaveAccrualProcessor.process` for the SAME
   * shape (a short bootstrap transaction, then a per-employee loop where
   * EACH employee opens its own short-lived transaction). Holding a
   * single transaction open for a potentially long branch-wide loop would
   * both violate 0.10's "no long-held transactions" posture and exhaust
   * the bounded connection pool the moment `processEmployee`'s own nested
   * `withTenantContext` calls tried to check out a second connection
   * while the first was still held.
   */
  async process(job: Job<PayrollRunJobData>): Promise<void> {
    const { tenantId, payrollRunId } = job.data;

    const { run, pack, employees, completedIds } = await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } });
      const pack = await resolvePayrollPackConfig(tx, tenantId, run.branchId);
      // FINAL_SETTLEMENT (step 2.3, additive — see docs/conventions/
      // recruitment-lifecycle.md): exactly the one (already possibly
      // non-ACTIVE) employee this run was created for, instead of the
      // branch's whole ACTIVE roster. `PayrollEngineService.computeForEmployee`
      // below is invoked identically either way — nothing about the
      // ENGINE changes, only which employees this WORKER iterates.
      const employees =
        run.runType === 'FINAL_SETTLEMENT'
          ? await tx.employee.findMany({ where: { id: run.settlementEmployeeId! } })
          : await tx.employee.findMany({ where: { branchId: run.branchId, status: 'ACTIVE' } });
      const alreadyComputed = await tx.payrollRunLine.findMany({
        where: { payrollRunId, status: 'COMPUTED' },
        select: { employeeId: true },
      });
      return { run, pack, employees, completedIds: new Set(alreadyComputed.map((line) => line.employeeId)) };
    });

    for (const employee of employees) {
      if (completedIds.has(employee.id)) {
        continue;
      }
      await this.processEmployee(tenantId, payrollRunId, run.branchId, employee.id, run, pack);
    }

    await withTenantContext(tenantId, (tx: Prisma.TransactionClient) => this.recomputeTotals(tx, tenantId, payrollRunId));
  }

  private async processEmployee(
    tenantId: string,
    payrollRunId: string,
    branchId: string,
    employeeId: string,
    run: { payrollMode: string; periodYear: number; periodMonth: number },
    pack: ResolvedPayrollPack,
  ): Promise<void> {
    const idempotencyKey = `${tenantId}:${payrollRunId}:${employeeId}`;

    try {
      // Deliberately let a per-employee failure THROW out of `fn()` here —
      // `IdempotencyService.execute` DELETES the Redis key on a thrown
      // error (never caches a failure as if it succeeded), which is
      // exactly what makes a later `calculate` call actually retry this
      // employee rather than treating a caught-and-recorded FAILED line as
      // "already done." The FAILED line itself is written in the `catch`
      // below, OUTSIDE the idempotency wrapper.
      await this.idempotency.execute(IDEMPOTENCY_SCOPE, idempotencyKey, () =>
        withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
          const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
          const period = { periodYear: run.periodYear, periodMonth: run.periodMonth };

          const result =
            run.payrollMode === 'DELEGATE'
              ? { ...(await this.delegateAdapter.submitEmployee(tx, tenantId, employee, pack, period)), computedVia: 'DELEGATE' as const }
              : { ...(await this.engine.computeForEmployee(tx, employee, pack, period)), computedVia: 'ENGINE' as const };

          await this.upsertLine(tx, tenantId, payrollRunId, employeeId, branchId, {
            status: 'COMPUTED',
            computedVia: result.computedVia,
            grossPay: result.grossPay,
            netPay: result.netPay,
            employerCost: result.employerCost,
            componentBreakdown: result.componentBreakdown as unknown as Prisma.InputJsonValue,
            errorMessage: null,
            computedAt: new Date(),
          });
        }),
      );
    } catch (error) {
      if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
        return; // Another worker/attempt already completed this employee — nothing to do.
      }
      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        this.upsertLine(tx, tenantId, payrollRunId, employeeId, branchId, {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async upsertLine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    payrollRunId: string,
    employeeId: string,
    branchId: string,
    data: Partial<Prisma.PayrollRunLineUncheckedCreateInput>,
  ): Promise<void> {
    try {
      await tx.payrollRunLine.upsert({
        where: { tenantId_payrollRunId_employeeId: { tenantId, payrollRunId, employeeId } },
        update: data,
        create: { tenantId, payrollRunId, employeeId, branchId, status: 'PENDING', ...data },
      });
    } catch (error) {
      if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
        return; // The DB-level idempotency backstop — a concurrent attempt already created this line.
      }
      throw error;
    }
  }

  private async recomputeTotals(tx: Prisma.TransactionClient, tenantId: string, payrollRunId: string): Promise<void> {
    const lines = await tx.payrollRunLine.findMany({ where: { payrollRunId } });
    const computedLines = lines.filter((line) => line.status === 'COMPUTED');
    const allComputed = lines.length > 0 && computedLines.length === lines.length;

    const totalGross = sumDecimal(computedLines.map((line) => line.grossPay));
    const totalNet = sumDecimal(computedLines.map((line) => line.netPay));
    const totalEmployerCost = sumDecimal(computedLines.map((line) => line.employerCost));

    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { baseCurrencyCode: true } });
    const asOfDate = new Date(Date.UTC(run.periodYear, run.periodMonth, 0));
    const { rate, totalGrossBase, totalNetBase } = await this.rollup.rollup(
      tx,
      run.currencyCode,
      tenant.baseCurrencyCode,
      asOfDate,
      totalGross,
      totalNet,
    );

    await tx.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        totalGross,
        totalNet,
        totalEmployerCost,
        exchangeRateToBase: rate,
        totalGrossBase,
        totalNetBase,
        ...(allComputed ? { status: 'CALCULATED' } : {}),
      },
    });
  }
}

function sumDecimal(values: (Prisma.Decimal | null)[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((sum, value) => sum.add(value ?? new PrismaNS.Decimal(0)), new PrismaNS.Decimal(0));
}
