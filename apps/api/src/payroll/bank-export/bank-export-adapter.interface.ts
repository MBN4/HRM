import type { PayrollRun, PayrollRunLine } from '@hrm/db';

export const BANK_EXPORT_ADAPTER = Symbol('BANK_EXPORT_ADAPTER');

export interface BankExportFile {
  format: string;
  fileName: string;
  contentType: string;
  body: Buffer;
}

/**
 * The bank-payment-file-export seam — same "swap one DI binding" shape as
 * every other adapter seam in this codebase (0.4 SSO, 0.8 notification
 * providers, 1.3 biometric device, this module's own DELEGATE seam).
 * `GenericCsvBankExportAdapter` (bound today) is the ONE reference format
 * — see docs/conventions/payroll.md's honest note on this: a real
 * country-specific format (NACHA, SEPA, ...) is a new adapter + a new
 * binding away, not a change to this interface or to `PayrollRunService`.
 */
export interface BankExportLineInput {
  line: PayrollRunLine;
  employeeCode: string;
  employeeName: string;
  bankAccountNumber: string | null;
  bankName: string | null;
}

export interface BankExportAdapter {
  generate(run: PayrollRun, lines: BankExportLineInput[]): BankExportFile;
}
