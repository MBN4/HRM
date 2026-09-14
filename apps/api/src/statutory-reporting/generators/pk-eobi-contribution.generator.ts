import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { breakdownAmount, findFinalizedPayrollRunLinesForMonth, statutoryField } from './finalized-payroll-lines.util';
import type { StatutoryReportData, StatutoryReportGenerationParams, StatutoryReportGenerator } from '../statutory-report-generator.interface';

/**
 * PK's EOBI monthly contribution return — see
 * docs/conventions/statutory-reporting.md. Reads the already wage-ceiling-
 * capped `eobi_employee`/`eobi_employer` `componentBreakdown` entries off
 * already-FINALIZED `PayrollRunLine` rows (the cap itself was applied by
 * the unmodified rules engine at CALCULATION time, per the Pakistan pack's
 * own `cap` — see docs/conventions/pakistan-pack.md; this generator never
 * re-derives it).
 */
@Injectable()
export class PkEobiContributionGenerator implements StatutoryReportGenerator {
  async generate(tx: Prisma.TransactionClient, params: StatutoryReportGenerationParams): Promise<StatutoryReportData> {
    if (params.periodMonth === undefined) {
      throw new BadRequestException('"periodMonth" is required for a MONTHLY report.');
    }
    const lines = await findFinalizedPayrollRunLinesForMonth(tx, params.tenantId, params.branchId, params.periodYear, params.periodMonth);

    const urdu = params.language === 'ur';
    const columns = [
      { key: 'eobiEmployee', label: urdu ? 'ای او بی آئی (ملازم)' : 'EOBI Employee Contribution' },
      { key: 'eobiEmployer', label: urdu ? 'ای او بی آئی (آجر)' : 'EOBI Employer Contribution' },
    ];

    const totals: Record<string, number> = { eobiEmployee: 0, eobiEmployer: 0 };
    const rows = lines.map((line) => {
      const eobiEmployee = breakdownAmount(line.componentBreakdown, 'eobi_employee');
      const eobiEmployer = breakdownAmount(line.componentBreakdown, 'eobi_employer');
      totals.eobiEmployee += eobiEmployee;
      totals.eobiEmployer += eobiEmployer;
      return {
        identity: {
          employeeId: line.employee.id,
          employeeCode: line.employee.employeeCode,
          employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
          cnic: statutoryField(line.employee, 'CNIC'),
          ntn: statutoryField(line.employee, 'NTN'),
        },
        values: { eobiEmployee, eobiEmployer },
      };
    });

    return {
      reportCode: 'PK_EOBI_CONTRIBUTION',
      reportName: 'EOBI monthly contribution return',
      countryCode: params.countryCode,
      currencyCode: params.currencyCode,
      periodLabel: `${params.periodYear}-${String(params.periodMonth).padStart(2, '0')}`,
      language: params.language,
      columns,
      rows,
      totals,
    };
  }
}
