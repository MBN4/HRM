import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { breakdownAmount, findFinalizedPayrollRunLinesForMonth, statutoryField } from './finalized-payroll-lines.util';
import type { StatutoryReportData, StatutoryReportGenerationParams, StatutoryReportGenerator } from '../statutory-report-generator.interface';

/**
 * PK's Provident Fund contribution report — see
 * docs/conventions/statutory-reporting.md. An internal/trustee-facing
 * report, not a direct government filing (whether a PF scheme applies at
 * all, and at what rate, is the client's own PF trust deed — see
 * docs/conventions/pakistan-pack.md's own VERIFY note on
 * `provident_fund_employee`/`_employer`). A branch whose resolved pack
 * carries no such component simply reports zero rows/totals — this
 * generator doesn't assume PK always has one.
 */
@Injectable()
export class PkProvidentFundContributionGenerator implements StatutoryReportGenerator {
  async generate(tx: Prisma.TransactionClient, params: StatutoryReportGenerationParams): Promise<StatutoryReportData> {
    if (params.periodMonth === undefined) {
      throw new BadRequestException('"periodMonth" is required for a MONTHLY report.');
    }
    const lines = await findFinalizedPayrollRunLinesForMonth(tx, params.tenantId, params.branchId, params.periodYear, params.periodMonth);

    const urdu = params.language === 'ur';
    const columns = [
      { key: 'pfEmployee', label: urdu ? 'پراویڈنٹ فنڈ (ملازم)' : 'Provident Fund Employee Contribution' },
      { key: 'pfEmployer', label: urdu ? 'پراویڈنٹ فنڈ (آجر)' : 'Provident Fund Employer Contribution' },
    ];

    const totals: Record<string, number> = { pfEmployee: 0, pfEmployer: 0 };
    const rows = lines.map((line) => {
      const pfEmployee = breakdownAmount(line.componentBreakdown, 'provident_fund_employee');
      const pfEmployer = breakdownAmount(line.componentBreakdown, 'provident_fund_employer');
      totals.pfEmployee += pfEmployee;
      totals.pfEmployer += pfEmployer;
      return {
        identity: {
          employeeId: line.employee.id,
          employeeCode: line.employee.employeeCode,
          employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
          cnic: statutoryField(line.employee, 'CNIC'),
          ntn: statutoryField(line.employee, 'NTN'),
        },
        values: { pfEmployee, pfEmployer },
      };
    });

    return {
      reportCode: 'PK_PROVIDENT_FUND_CONTRIBUTION',
      reportName: 'Provident Fund contribution report',
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
