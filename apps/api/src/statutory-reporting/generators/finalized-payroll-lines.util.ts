import { BadRequestException } from '@nestjs/common';
import type { Employee, Prisma } from '@hrm/db';
import { REPORTABLE_PAYROLL_RUN_STATUSES } from '../statutory-reporting.constants';

export interface FinalizedPayrollRunLine {
  employee: Employee;
  grossPay: Prisma.Decimal | null;
  netPay: Prisma.Decimal | null;
  componentBreakdown: unknown;
}

/**
 * The ONE place every PK report generator reads payroll data from — see
 * docs/conventions/statutory-reporting.md's "generation reads only
 * finalized-run data" rule. A branch/period with no `FINALIZED`/`PAID` run
 * (still `DRAFT`/`CALCULATED`/`APPROVED`, or simply never run) throws
 * loudly rather than silently reporting zero employees — the same
 * "no `missing_ok`" posture Country Pack resolution already holds itself
 * to (see docs/conventions/country-packs.md). Includes BOTH `REGULAR` and
 * `FINAL_SETTLEMENT` runs for the period — a leaver's final-month
 * withholding still belongs in that month's statutory filing.
 */
export async function findFinalizedPayrollRunLinesForMonth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  periodYear: number,
  periodMonth: number,
): Promise<FinalizedPayrollRunLine[]> {
  const runs = await tx.payrollRun.findMany({
    where: { tenantId, branchId, periodYear, periodMonth, status: { in: [...REPORTABLE_PAYROLL_RUN_STATUSES] } },
  });
  if (runs.length === 0) {
    throw new BadRequestException(
      `No finalized payroll run exists for this branch for ${periodYear}-${String(periodMonth).padStart(2, '0')} — statutory reports only pull from finalized run data.`,
    );
  }

  const lines = await tx.payrollRunLine.findMany({
    where: { tenantId, payrollRunId: { in: runs.map((run) => run.id) }, status: 'COMPUTED' },
    include: { employee: true },
  });
  return lines;
}

/** The ANNUAL-report counterpart — every finalized month in the year, across the whole branch. Throws the same way if NONE of the twelve months has a finalized run. */
export async function findFinalizedPayrollRunLinesForYear(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  periodYear: number,
): Promise<FinalizedPayrollRunLine[]> {
  const runs = await tx.payrollRun.findMany({
    where: { tenantId, branchId, periodYear, status: { in: [...REPORTABLE_PAYROLL_RUN_STATUSES] } },
  });
  if (runs.length === 0) {
    throw new BadRequestException(`No finalized payroll run exists for this branch for ${periodYear} — statutory reports only pull from finalized run data.`);
  }

  const lines = await tx.payrollRunLine.findMany({
    where: { tenantId, payrollRunId: { in: runs.map((run) => run.id) }, status: 'COMPUTED' },
    include: { employee: true },
  });
  return lines;
}

/** `Employee.statutoryFields` is a plain `Record<string,string>` keyed by the resolved pack's own opaque `requiredEmployeeFields` (see docs/conventions/employee.md) — `CNIC`/`NTN` are PK's own two keys (see docs/conventions/pakistan-pack.md), read verbatim, never re-validated here. */
export function statutoryField(employee: Employee, key: string): string | null {
  const fields = (employee.statutoryFields as Record<string, string> | null) ?? {};
  return fields[key] || null;
}

/** A `componentBreakdown` entry's `amount` for a given `key`, or 0 if that component didn't apply to this employee's run (e.g. a country pack changed between two periods). */
export function breakdownAmount(componentBreakdown: unknown, key: string): number {
  if (!Array.isArray(componentBreakdown)) {
    return 0;
  }
  const entry = (componentBreakdown as { key: string; amount: number }[]).find((c) => c.key === key);
  return entry?.amount ?? 0;
}
