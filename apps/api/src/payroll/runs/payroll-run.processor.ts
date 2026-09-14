import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Employee, Prisma } from '@hrm/db';
import { Prisma as PrismaNS, withTenantContext } from '@hrm/db';
import { PAYROLL_RUN_QUEUE } from '../../queue/queue.constants';
import { shouldAutorunWorkers } from '../../queue/queue-worker.util';
import { IdempotencyService } from '../../resilience/idempotency/idempotency.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { resolveActiveBenefitContributions } from '../../benefits/benefits-payroll-input.util';
import { resolvePayrollPackConfig, ResolvedPayrollPack } from '../payroll-pack.util';
import { PayrollEngineService } from '../engine/payroll-engine.service';
import { PAYROLL_PROVIDER_ADAPTER, PayrollProviderAdapter } from '../delegate/payroll-provider.interface';
import { buildPayrollVariables, computeYearsOfService, periodEndDate, periodStartDate } from '../payroll-variables.util';
import { MultiCurrencyRollupService } from './multi-currency-rollup.service';
import { ExchangeRateService } from './exchange-rate.service';
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
@Processor(PAYROLL_RUN_QUEUE, { autorun: shouldAutorunWorkers() })
export class PayrollRunProcessor extends WorkerHost {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly engine: PayrollEngineService,
    private readonly rollup: MultiCurrencyRollupService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly encryption: EncryptionService,
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
    run: { payrollMode: string; periodYear: number; periodMonth: number; currencyCode: string },
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

          // Benefits payroll-input hand-off (step 3.5.2, ORCHESTRATION
          // only — see docs/conventions/benefits.md). Mirrors the
          // reimbursement hand-off below exactly: an additive touch to
          // this PROCESSOR, never to `PayrollEngineService`/the rules
          // engine. Every ACTIVE, payroll-affecting `BenefitEnrollment`
          // for this employee/period produces an employee deduction/
          // employer contribution pair, applied BEFORE reimbursements
          // (a benefit contribution is computed against GROSS pay, the
          // same timing a CountryPack statutory component uses; a
          // reimbursement is explicitly a straight net-pay add-on, the
          // last step).
          const withBenefits = await this.mergeBenefitContributions(tx, tenantId, employee, run, result);

          // Expense reimbursement hand-off (step 3.1, ORCHESTRATION only —
          // see docs/conventions/operations-modules.md). Mirrors the
          // FINAL_SETTLEMENT hand-off's own shape: an additive touch to
          // this PROCESSOR, never to `PayrollEngineService`/the rules
          // engine. Any of this employee's APPROVED, not-yet-consumed
          // `ExpenseClaim`s are added straight onto net pay/employer cost
          // (non-taxable — reimbursements never flow through
          // tax/statutory computation) and marked REIMBURSED once this
          // line is durably written below.
          const { netPay, employerCost, componentBreakdown, reimbursedClaimIds } = await this.mergeReimbursements(
            tx,
            tenantId,
            employeeId,
            run.currencyCode,
            withBenefits,
          );

          await this.upsertLine(tx, tenantId, payrollRunId, employeeId, branchId, {
            status: 'COMPUTED',
            computedVia: result.computedVia,
            grossPay: result.grossPay,
            netPay,
            employerCost,
            componentBreakdown: componentBreakdown as unknown as Prisma.InputJsonValue,
            errorMessage: null,
            computedAt: new Date(),
          });

          const line = await tx.payrollRunLine.findUniqueOrThrow({
            where: { tenantId_payrollRunId_employeeId: { tenantId, payrollRunId, employeeId } },
          });

          if (reimbursedClaimIds.length > 0) {
            await tx.expenseClaim.updateMany({
              where: { tenantId, id: { in: reimbursedClaimIds } },
              data: { status: 'REIMBURSED', reimbursementPayrollRunLineId: line.id, reimbursedAt: new Date() },
            });
          }

          for (const contribution of withBenefits.contributions) {
            await tx.benefitContributionRecord.upsert({
              where: {
                tenantId_enrollmentId_periodYear_periodMonth: {
                  tenantId,
                  enrollmentId: contribution.enrollmentId,
                  periodYear: run.periodYear,
                  periodMonth: run.periodMonth,
                },
              },
              update: { payrollRunId, payrollRunLineId: line.id, employeeAmount: contribution.employeeAmount, employerAmount: contribution.employerAmount },
              create: {
                tenantId,
                employeeId,
                planId: contribution.planId,
                enrollmentId: contribution.enrollmentId,
                payrollRunId,
                payrollRunLineId: line.id,
                periodYear: run.periodYear,
                periodMonth: run.periodMonth,
                currencyCode: run.currencyCode,
                employeeAmount: contribution.employeeAmount,
                employerAmount: contribution.employerAmount,
              },
            });
          }
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

  /**
   * Sums every APPROVED, not-yet-consumed `ExpenseClaim` for this employee
   * (regardless of `run.runType` — a leaver's outstanding approved claims
   * are deliberately included in their FINAL_SETTLEMENT run too) and adds
   * the total straight onto net pay/employer cost, converting into the
   * RUN's own currency via the SAME `ExchangeRateService` Payroll already
   * uses for its base-currency rollup. A claim approved AFTER this
   * employee's line is already `COMPUTED` is picked up on the NEXT run,
   * never retroactively — the same "resumability skips an already-COMPUTED
   * employee entirely" posture this file already documents for itself.
   */
  private async mergeReimbursements(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    runCurrency: string,
    result: { netPay: number; employerCost: number; componentBreakdown: unknown },
  ): Promise<{ netPay: Prisma.Decimal; employerCost: Prisma.Decimal; componentBreakdown: unknown; reimbursedClaimIds: string[] }> {
    const claims = await tx.expenseClaim.findMany({
      where: { tenantId, employeeId, status: 'APPROVED', reimbursementPayrollRunLineId: null },
    });
    if (claims.length === 0) {
      return {
        netPay: new PrismaNS.Decimal(result.netPay),
        employerCost: new PrismaNS.Decimal(result.employerCost),
        componentBreakdown: result.componentBreakdown,
        reimbursedClaimIds: [],
      };
    }

    let reimbursementTotal = new PrismaNS.Decimal(0);
    for (const claim of claims) {
      const amountInRunCurrency =
        claim.currencyCode === runCurrency
          ? claim.totalAmount
          : claim.totalAmount.mul(await this.exchangeRates.getRate(tx, claim.currencyCode, runCurrency, new Date())).toDecimalPlaces(2);
      reimbursementTotal = reimbursementTotal.add(amountInRunCurrency);
    }

    // `componentBreakdown` is the engine's own ORDERED `{key,label,type,
    // amount}[]` (see `PayrollComputationResult`) — appended to, never
    // reshaped into an object, so the payslip renderer's existing
    // key-lookup-by-line-item contract is unaffected.
    const breakdown = Array.isArray(result.componentBreakdown) ? [...result.componentBreakdown] : [];
    breakdown.push({ key: 'reimbursements', label: 'Reimbursements', type: 'EARNING', amount: reimbursementTotal.toNumber() });

    return {
      netPay: new PrismaNS.Decimal(result.netPay).add(reimbursementTotal),
      employerCost: new PrismaNS.Decimal(result.employerCost).add(reimbursementTotal),
      componentBreakdown: breakdown,
      reimbursedClaimIds: claims.map((claim) => claim.id),
    };
  }

  /**
   * Every ACTIVE, payroll-affecting `BenefitEnrollment` for this employee/
   * period (see `resolveActiveBenefitContributions`, imported directly —
   * plain-function reuse across the module boundary, the SAME
   * `countBusinessDays`/`computeStatutoryComponent` pattern this
   * processor/engine already establish) produces an employee deduction +
   * employer contribution pair, added straight onto net pay/employer cost
   * — see docs/conventions/benefits.md. Computed against the variables the
   * engine/adapter has ALREADY resolved this period (`result.grossPay`),
   * exactly like a CountryPack `statutory.component` would be. Persisting
   * the actual `BenefitContributionRecord` rows happens back in
   * `processEmployee`, once this employee's line id is known.
   */
  private async mergeBenefitContributions(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Employee,
    run: { periodYear: number; periodMonth: number },
    result: { grossPay: number; netPay: number; employerCost: number; componentBreakdown: unknown },
  ): Promise<{
    netPay: number;
    employerCost: number;
    componentBreakdown: unknown;
    contributions: { enrollmentId: string; planId: string; employeeAmount: number; employerAmount: number }[];
  }> {
    const periodStart = periodStartDate(run.periodYear, run.periodMonth);
    const periodEnd = periodEndDate(run.periodYear, run.periodMonth);
    const basicSalaryMonthly = employee.baseSalaryEncrypted ? Number(this.encryption.decrypt(employee.baseSalaryEncrypted)) : 0;
    const yearsOfService = computeYearsOfService(employee.joinDate, periodEnd);
    const variables = buildPayrollVariables({ basicSalaryMonthly, periodGross: result.grossPay, yearsOfService });

    const resolved = await resolveActiveBenefitContributions(tx, tenantId, employee, periodStart, periodEnd, variables);
    if (resolved.length === 0) {
      return { netPay: result.netPay, employerCost: result.employerCost, componentBreakdown: result.componentBreakdown, contributions: [] };
    }

    const breakdown = Array.isArray(result.componentBreakdown) ? [...(result.componentBreakdown as unknown[])] : [];
    let netPay = result.netPay;
    let employerCost = result.employerCost;
    const contributions: { enrollmentId: string; planId: string; employeeAmount: number; employerAmount: number }[] = [];

    for (const { enrollment, contribution } of resolved) {
      if (contribution.employeeAmount > 0) {
        netPay -= contribution.employeeAmount;
        breakdown.push({ key: `benefit_${enrollment.planId}_employee`, label: `${contribution.planName} (Employee)`, type: 'DEDUCTION', amount: contribution.employeeAmount });
      }
      if (contribution.employerAmount > 0) {
        employerCost += contribution.employerAmount;
        breakdown.push({ key: `benefit_${enrollment.planId}_employer`, label: `${contribution.planName} (Employer)`, type: 'EMPLOYER_COST', amount: contribution.employerAmount });
      }
      contributions.push({
        enrollmentId: contribution.enrollmentId,
        planId: contribution.planId,
        employeeAmount: contribution.employeeAmount,
        employerAmount: contribution.employerAmount,
      });
    }

    return { netPay: round2(netPay), employerCost: round2(employerCost), componentBreakdown: breakdown, contributions };
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumDecimal(values: (Prisma.Decimal | null)[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((sum, value) => sum.add(value ?? new PrismaNS.Decimal(0)), new PrismaNS.Decimal(0));
}
