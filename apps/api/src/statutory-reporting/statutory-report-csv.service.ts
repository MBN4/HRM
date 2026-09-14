import { Injectable } from '@nestjs/common';
import type { StatutoryReportData } from './statutory-report-generator.interface';

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Renders one generated statutory report as a structured CSV export — the
 * SAME plain-CSV, hand-escaped approach `GenericCsvBankExportAdapter`
 * (payroll's own reference bank-export format, step 2.1/3.3) already
 * establishes, reused rather than pulling in a heavier spreadsheet
 * dependency for what is, per-row, the same flat tabular shape. Suitable
 * for uploading through an authority's own portal where one accepts a
 * generic CSV — see docs/conventions/statutory-reporting.md for the
 * honest "exact mandated file format not certified" caveat this shares
 * with the PDF rendering.
 */
@Injectable()
export class StatutoryReportCsvService {
  render(data: StatutoryReportData): Buffer {
    const header = ['employee_code', 'employee_name', 'cnic', 'ntn', ...data.columns.map((c) => c.key)].join(',');
    const rows = data.rows.map((row) =>
      [
        csvField(row.identity.employeeCode),
        csvField(row.identity.employeeName),
        csvField(row.identity.cnic ?? ''),
        csvField(row.identity.ntn ?? ''),
        ...data.columns.map((c) => (row.values[c.key] ?? 0).toFixed(2)),
      ].join(','),
    );
    const totalRow = ['', csvField('TOTAL'), '', '', ...data.columns.map((c) => (data.totals[c.key] ?? 0).toFixed(2))].join(',');

    return Buffer.from([header, ...rows, totalRow].join('\n'), 'utf8');
  }
}
