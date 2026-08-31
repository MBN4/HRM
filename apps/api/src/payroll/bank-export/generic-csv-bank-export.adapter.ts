import { Injectable } from '@nestjs/common';
import type { PayrollRun } from '@hrm/db';
import { GENERIC_CSV_BANK_EXPORT_FORMAT } from '../payroll.constants';
import type { BankExportAdapter, BankExportFile, BankExportLineInput } from './bank-export-adapter.interface';

const CSV_HEADER = ['employee_code', 'employee_name', 'bank_name', 'bank_account_number', 'amount', 'currency'].join(',');

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The one reference bank-export format bound today — see
 * docs/conventions/payroll.md. A plain, generic CSV: no country-specific
 * fixed-width/NACHA/SEPA format is implemented (out of this step's scope
 * — the seam is what matters, not a certified real-world file format).
 */
@Injectable()
export class GenericCsvBankExportAdapter implements BankExportAdapter {
  generate(run: PayrollRun, lines: BankExportLineInput[]): BankExportFile {
    const rows = lines.map((input) =>
      [
        csvField(input.employeeCode),
        csvField(input.employeeName),
        csvField(input.bankName ?? ''),
        csvField(input.bankAccountNumber ?? ''),
        (input.line.netPay ?? 0).toString(),
        run.currencyCode,
      ].join(','),
    );
    const body = Buffer.from([CSV_HEADER, ...rows].join('\n'), 'utf8');

    return {
      format: GENERIC_CSV_BANK_EXPORT_FORMAT,
      fileName: `payroll-${run.id}-bank-export.csv`,
      contentType: 'text/csv',
      body,
    };
  }
}
