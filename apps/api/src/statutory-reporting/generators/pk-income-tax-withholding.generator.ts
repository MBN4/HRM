import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { breakdownAmount, findFinalizedPayrollRunLinesForMonth, statutoryField } from './finalized-payroll-lines.util';
import type { StatutoryReportData, StatutoryReportGenerationParams, StatutoryReportGenerator } from '../statutory-report-generator.interface';

/**
 * PK's monthly income tax withholding statement — see
 * docs/conventions/statutory-reporting.md and
 * `packages/db/src/seed-statutory-report-definitions.ts`'s own
 * `complianceNote`. Reads `income_tax`-keyed `componentBreakdown` entries
 * off already-FINALIZED `PayrollRunLine` rows — never recomputes tax.
 */
@Injectable()
export class PkIncomeTaxWithholdingGenerator implements StatutoryReportGenerator {
  async generate(tx: Prisma.TransactionClient, params: StatutoryReportGenerationParams): Promise<StatutoryReportData> {
    if (params.periodMonth === undefined) {
      throw new BadRequestException('"periodMonth" is required for a MONTHLY report.');
    }
    const lines = await findFinalizedPayrollRunLinesForMonth(tx, params.tenantId, params.branchId, params.periodYear, params.periodMonth);

    const urdu = params.language === 'ur';
    const columns = [
      { key: 'grossPay', label: urdu ? 'مجموعی تنخواہ' : 'Gross Pay' },
      { key: 'taxWithheld', label: urdu ? 'انکم ٹیکس' : 'Income Tax Withheld' },
    ];

    const totals: Record<string, number> = { grossPay: 0, taxWithheld: 0 };
    const rows = lines.map((line) => {
      const grossPay = Number(line.grossPay ?? 0);
      const taxWithheld = breakdownAmount(line.componentBreakdown, 'income_tax');
      totals.grossPay += grossPay;
      totals.taxWithheld += taxWithheld;
      return {
        identity: {
          employeeId: line.employee.id,
          employeeCode: line.employee.employeeCode,
          employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
          cnic: statutoryField(line.employee, 'CNIC'),
          ntn: statutoryField(line.employee, 'NTN'),
        },
        values: { grossPay, taxWithheld },
      };
    });

    return {
      reportCode: 'PK_INCOME_TAX_WITHHOLDING',
      reportName: 'Monthly income tax withholding statement',
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
