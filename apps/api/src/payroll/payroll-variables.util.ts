import type { ExprVariable } from '@hrm/shared';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

/**
 * Fractional years between `joinDate` and `asOfDate` — feeds the 0.5
 * `yearsOfService` variable (e.g. Qatar's tiered end-of-service gratuity).
 * Never negative (a join date in the future, or `asOfDate` before it,
 * clamps to 0 rather than reporting a nonsensical negative tenure).
 */
export function computeYearsOfService(joinDate: Date, asOfDate: Date): number {
  const days = (asOfDate.getTime() - joinDate.getTime()) / MS_PER_DAY;
  return Math.max(0, days / DAYS_PER_YEAR);
}

export interface PayrollVariableInputs {
  /** The employee's contractual monthly base pay (decrypted, unadjusted by attendance). */
  basicSalaryMonthly: number;
  /** This period's ACTUAL computed gross (basic pro-rated for unpaid leave + earnings/allowances + overtime pay). */
  periodGross: number;
  yearsOfService: number;
}

/**
 * Builds the `{ [variable]: number }` map fed into 0.5's `evaluateExpression`/
 * `computeMultiLayerTax`/`computeStatutoryComponents` — see
 * docs/conventions/payroll.md's "variable semantics" note for exactly what
 * each of these four means and why. `grossSalary`/`monthlySalary` are
 * DELIBERATELY the same figure (this period's actual gross) — packs may
 * use either name; `annualSalary` is an ANNUALIZED PROJECTION
 * (`periodGross * 12`), not a year-to-date running total.
 */
export function buildPayrollVariables(inputs: PayrollVariableInputs): Record<ExprVariable, number> {
  return {
    basicSalary: inputs.basicSalaryMonthly,
    grossSalary: inputs.periodGross,
    monthlySalary: inputs.periodGross,
    annualSalary: inputs.periodGross * 12,
    yearsOfService: inputs.yearsOfService,
  };
}

/** The last calendar day of `(periodYear, periodMonth)`, UTC — used as "as of" for years-of-service and as the exchange-rate lookup date. */
export function periodEndDate(periodYear: number, periodMonth: number): Date {
  // Day 0 of the FOLLOWING month is the last day of `periodMonth` — a
  // standard UTC-safe idiom, consistent with this codebase's "never touch
  // the server process's local timezone" convention (see
  // docs/conventions/i18n-timezone-rtl.md).
  return new Date(Date.UTC(periodYear, periodMonth, 0));
}

/** The first calendar day of `(periodYear, periodMonth)`, UTC. */
export function periodStartDate(periodYear: number, periodMonth: number): Date {
  return new Date(Date.UTC(periodYear, periodMonth - 1, 1));
}
