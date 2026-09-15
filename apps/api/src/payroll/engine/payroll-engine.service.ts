import { Injectable } from '@nestjs/common';
import type { Employee, PayrollComponentDefinition, Prisma } from '@hrm/db';
import type { Expr, StatutoryComponent, TaxLayer } from '@hrm/shared';
import { evaluateExpression } from '../../country-packs/rules-engine/expression-evaluator';
import { computeMultiLayerTax } from '../../country-packs/rules-engine/tax-calculator';
import { computeStatutoryComponent } from '../../country-packs/rules-engine/statutory-calculator';
import { countBusinessDays } from '../../leave/leave-day-calculator';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { UNPAID_ATTENDANCE_STATUS } from '../payroll.constants';
import type { ResolvedPayrollPack } from '../payroll-pack.util';
import { buildPayrollVariables, computeYearsOfService, periodEndDate, periodStartDate } from '../payroll-variables.util';
import { PayrollComponentDefinitionService } from '../components/payroll-component-definition.service';

export interface PayrollComponentLine {
  key: string;
  label: string;
  type: 'EARNING' | 'ALLOWANCE' | 'DEDUCTION' | 'TAX' | 'EMPLOYEE_STATUTORY' | 'EMPLOYER_COST' | 'SUBTOTAL';
  amount: number;
}

export interface PayrollComputationResult {
  grossPay: number;
  netPay: number;
  employerCost: number;
  componentBreakdown: PayrollComponentLine[];
}

const HOURS_PER_STANDARD_YEAR_WEEKS = 52;

/**
 * THE CALCULATE-mode engine — see docs/conventions/payroll.md. This is the
 * ONE function proven against BOTH reference packs (US 4-layer tax, Qatar
 * no-income-tax + tiered gratuity) from the SAME code path — nothing here
 * ever branches on a country code. Mandatory tax/statutory deductions come
 * straight from the resolved pack's `tax.layers`/`statutory.components`
 * via the EXISTING, UNMODIFIED `computeMultiLayerTax`/
 * `computeStatutoryComponents` (0.5) — this class never reimplements that
 * math, it only builds the `variables` those functions are evaluated
 * against and assembles the result into a payslip-ready breakdown.
 */
@Injectable()
export class PayrollEngineService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly components: PayrollComponentDefinitionService,
  ) {}

  async computeForEmployee(
    tx: Prisma.TransactionClient,
    employee: Employee,
    pack: ResolvedPayrollPack,
    period: { periodYear: number; periodMonth: number },
    // Phase 5.4 — OPTIONAL: a caller iterating many employees in the SAME
    // run (the only real caller today, `PayrollRunProcessor`) can pre-fetch
    // this ONCE and pass it in, since it depends only on `pack.countryCode`
    // — identical for every employee in one run — never anything
    // employee-specific. A real, measured N+1 this closes: see
    // docs/conventions/observability-load.md § Load testing findings.
    // Omitted (any future caller computing a one-off preview) falls back
    // to fetching it here, exactly as before this step.
    componentDefs?: PayrollComponentDefinition[],
  ): Promise<PayrollComputationResult> {
    const start = periodStartDate(period.periodYear, period.periodMonth);
    const end = periodEndDate(period.periodYear, period.periodMonth);

    const basicSalaryMonthly = employee.baseSalaryEncrypted ? Number(this.encryption.decrypt(employee.baseSalaryEncrypted)) : 0;
    const yearsOfService = computeYearsOfService(employee.joinDate, end);
    const yearsOfServiceAtPeriodStart = computeYearsOfService(employee.joinDate, start);

    // Attendance/overtime (1.3) and unpaid-leave (1.2) feed the
    // calculation — reused from the ALREADY-COMPUTED `AttendanceDailySummary`
    // rollup (1.3), never a live scan of raw `AttendanceRecord`. "Unpaid
    // leave" = an ABSENT day in that summary (see payroll.md for why this
    // reuses attendance data rather than inventing a new Leave concept).
    const summaries = await tx.attendanceDailySummary.findMany({
      where: { employeeId: employee.id, workDate: { gte: start, lte: end } },
    });
    const overtimeMinutes = summaries.reduce((sum, row) => sum + row.overtimeMinutes, 0);
    const unpaidDays = summaries.filter((row) => row.status === UNPAID_ATTENDANCE_STATUS).length;

    const workingDaysInPeriod = countBusinessDays(start, end, pack.config.workingTime.weekendDays, pack.config.publicHolidays);
    const dailyRate = workingDaysInPeriod > 0 ? basicSalaryMonthly / workingDaysInPeriod : 0;
    const unpaidDeduction = round2(dailyRate * unpaidDays);

    const annualStandardHours = pack.config.workingTime.standardWeeklyHours * HOURS_PER_STANDARD_YEAR_WEEKS;
    const hourlyRate = annualStandardHours > 0 ? (basicSalaryMonthly * 12) / annualStandardHours : 0;
    const overtimePay = round2((overtimeMinutes / 60) * hourlyRate * pack.config.workingTime.overtimeRules.multiplier);

    const resolvedComponentDefs = componentDefs ?? (await this.components.listActive(tx, pack.countryCode));
    const preGrossVariables = { basicSalary: basicSalaryMonthly, yearsOfService };

    const componentLines: PayrollComponentLine[] = [
      { key: 'basic', label: 'Basic Salary', type: 'EARNING', amount: round2(basicSalaryMonthly) },
    ];
    if (unpaidDeduction > 0) {
      componentLines.push({ key: 'unpaid_leave', label: 'Unpaid Leave Deduction', type: 'DEDUCTION', amount: unpaidDeduction });
    }
    if (overtimePay > 0) {
      componentLines.push({ key: 'overtime', label: 'Overtime', type: 'EARNING', amount: overtimePay });
    }

    let earningsTotal = 0;
    let discretionaryDeductionsTotal = 0;
    for (const def of resolvedComponentDefs) {
      const amount = round2(computeComponentAmount(def, preGrossVariables));
      componentLines.push({ key: def.key, label: def.name, type: def.type, amount });
      if (def.type === 'DEDUCTION') {
        discretionaryDeductionsTotal += amount;
      } else {
        earningsTotal += amount;
      }
    }

    const grossPay = round2(basicSalaryMonthly - unpaidDeduction + overtimePay + earningsTotal - discretionaryDeductionsTotal);
    componentLines.push({ key: 'gross', label: 'Gross Pay', type: 'SUBTOTAL', amount: grossPay });

    const variables = buildPayrollVariables({ basicSalaryMonthly, periodGross: grossPay, yearsOfService });

    // ANNUALIZE, COMPUTE, DE-ANNUALIZE — the standard technique for
    // running an annual progressive-bracket tax table against a periodic
    // (monthly) payroll run: `computeMultiLayerTax` returns the ANNUAL tax
    // owed on `annualSalary`, for any layer whose OWN declared `base` is
    // `annualSalary` (US federal/state/FICA all are) — dividing that
    // layer's result by 12 recovers this MONTH's correct withholding.
    // A layer/component whose base is already period-sized (`grossSalary`/
    // `monthlySalary`/`basicSalary`) needs no adjustment. `FORMULA`
    // layers/components have no explicit `.base` field to inspect — their
    // result is taken AS-IS (the formula author is responsible for writing
    // whatever period the formula itself represents); `TIERED_BY_YEARS_OF_
    // SERVICE` (e.g. Qatar's gratuity) is a cumulative LUMP-SUM total
    // earned over the whole tenure, never period-divided either.
    const rawTaxResult = computeMultiLayerTax(pack.config.tax.layers, variables);
    let totalTax = 0;
    rawTaxResult.layers.forEach((result, index) => {
      const amount = round2(result.amount / periodDivisorForTaxLayer(pack.config.tax.layers[index]));
      totalTax += amount;
      componentLines.push({ key: result.name, label: result.name, type: 'TAX', amount });
    });
    totalTax = round2(totalTax);

    // `TIERED_BY_YEARS_OF_SERVICE` (e.g. Qatar's end-of-service gratuity)
    // returns a CUMULATIVE total earned over the WHOLE tenure to date —
    // that is what `computeTieredByYearsOfService` is defined to compute
    // (0.5, unmodified). Using that cumulative figure directly as THIS
    // period's employer cost would double-count every single month
    // forever. The correct period amount is the INCREMENTAL delta: the
    // cumulative total as of this period's end MINUS the cumulative total
    // as of its start — computed by calling the SAME unmodified
    // `computeStatutoryComponent` twice with two different
    // `yearsOfService` values, never a second implementation of the
    // tiering math itself.
    let employeeStatutoryTotal = 0;
    let employerStatutoryTotal = 0;
    pack.config.statutory.components.forEach((component) => {
      const atEnd = computeStatutoryComponent(component, { ...variables, yearsOfService });
      let amount: number;
      if (component.kind === 'TIERED_BY_YEARS_OF_SERVICE') {
        const atStart = computeStatutoryComponent(component, { ...variables, yearsOfService: yearsOfServiceAtPeriodStart });
        amount = round2(atEnd.amount - atStart.amount);
      } else {
        amount = round2(atEnd.amount / periodDivisorForStatutoryComponent(component));
      }

      if (atEnd.appliesTo === 'EMPLOYEE' || atEnd.appliesTo === 'BOTH') {
        employeeStatutoryTotal += amount;
        componentLines.push({ key: atEnd.name, label: atEnd.name, type: 'EMPLOYEE_STATUTORY', amount });
      }
      if (atEnd.appliesTo === 'EMPLOYER' || atEnd.appliesTo === 'BOTH') {
        employerStatutoryTotal += amount;
        componentLines.push({ key: atEnd.name, label: atEnd.name, type: 'EMPLOYER_COST', amount });
      }
    });

    const netPay = round2(grossPay - totalTax - employeeStatutoryTotal);
    const employerCost = round2(grossPay + employerStatutoryTotal);
    componentLines.push({ key: 'net', label: 'Net Pay', type: 'SUBTOTAL', amount: netPay });

    return { grossPay, netPay, employerCost, componentBreakdown: componentLines };
  }
}

function computeComponentAmount(
  def: { calcKind: string; fixedAmount: unknown; percentageRate: number | null; formula: unknown },
  variables: { basicSalary: number; yearsOfService: number },
): number {
  switch (def.calcKind) {
    case 'FIXED_AMOUNT':
      return Number(def.fixedAmount ?? 0);
    case 'PERCENTAGE_OF_BASE':
      return variables.basicSalary * (def.percentageRate ?? 0);
    case 'FORMULA':
      return evaluateExpression(def.formula as Expr, variables);
    default:
      return 0;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** See the ANNUALIZE/DE-ANNUALIZE comment above — only an `annualSalary`-based layer needs dividing by 12 to recover this period's withholding. */
function periodDivisorForTaxLayer(layer: TaxLayer): number {
  return layer.kind !== 'FORMULA' && layer.base === 'annualSalary' ? 12 : 1;
}

function periodDivisorForStatutoryComponent(component: StatutoryComponent): number {
  return component.kind === 'PERCENTAGE' && component.base === 'annualSalary' ? 12 : 1;
}
