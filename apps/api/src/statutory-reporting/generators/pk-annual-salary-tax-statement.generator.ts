import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { breakdownAmount, findFinalizedPayrollRunLinesForYear, statutoryField } from './finalized-payroll-lines.util';
import type {
  StatutoryReportData,
  StatutoryReportEmployeeIdentity,
  StatutoryReportGenerationParams,
  StatutoryReportGenerator,
} from '../statutory-report-generator.interface';

/**
 * PK's annual salary & tax withholding statement — see
 * docs/conventions/statutory-reporting.md. Unlike the three MONTHLY
 * generators (one `PayrollRunLine` == one report row), this ANNUAL report
 * needs ONE ROW PER EMPLOYEE summarizing every finalized month in the
 * year — a real employee may have more than one finalized line in the
 * year (twelve regular monthly runs, plus a possible `FINAL_SETTLEMENT`
 * run if they left mid-year), so this generator GROUPS BY employee and
 * sums `grossPay`/`income_tax` across every line, rather than emitting one
 * row per line like the monthly reports do.
 */
@Injectable()
export class PkAnnualSalaryTaxStatementGenerator implements StatutoryReportGenerator {
  async generate(tx: Prisma.TransactionClient, params: StatutoryReportGenerationParams): Promise<StatutoryReportData> {
    const lines = await findFinalizedPayrollRunLinesForYear(tx, params.tenantId, params.branchId, params.periodYear);

    const urdu = params.language === 'ur';
    const columns = [
      { key: 'grossPay', label: urdu ? 'مجموعی تنخواہ (سالانہ)' : 'Total Gross Pay (Annual)' },
      { key: 'taxWithheld', label: urdu ? 'انکم ٹیکس (سالانہ)' : 'Total Income Tax Withheld (Annual)' },
    ];

    const byEmployee = new Map<string, { identity: StatutoryReportEmployeeIdentity; grossPay: number; taxWithheld: number }>();
    for (const line of lines) {
      const existing = byEmployee.get(line.employee.id) ?? {
        identity: {
          employeeId: line.employee.id,
          employeeCode: line.employee.employeeCode,
          employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
          cnic: statutoryField(line.employee, 'CNIC'),
          ntn: statutoryField(line.employee, 'NTN'),
        },
        grossPay: 0,
        taxWithheld: 0,
      };
      existing.grossPay += Number(line.grossPay ?? 0);
      existing.taxWithheld += breakdownAmount(line.componentBreakdown, 'income_tax');
      byEmployee.set(line.employee.id, existing);
    }

    const totals: Record<string, number> = { grossPay: 0, taxWithheld: 0 };
    const rows = Array.from(byEmployee.values()).map((entry) => {
      totals.grossPay += entry.grossPay;
      totals.taxWithheld += entry.taxWithheld;
      return { identity: entry.identity, values: { grossPay: entry.grossPay, taxWithheld: entry.taxWithheld } };
    });

    return {
      reportCode: 'PK_ANNUAL_SALARY_TAX_STATEMENT',
      reportName: 'Annual salary & tax withholding statement',
      countryCode: params.countryCode,
      currencyCode: params.currencyCode,
      periodLabel: `${params.periodYear}`,
      language: params.language,
      columns,
      rows,
      totals,
    };
  }
}
