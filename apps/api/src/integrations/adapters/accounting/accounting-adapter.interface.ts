import type { ExpenseClaim, PayrollRun } from '@hrm/db';

export const ACCOUNTING_ADAPTER = Symbol('ACCOUNTING_ADAPTER');

export interface AccountingExportResult {
  externalReference: string;
  exportedAt: string;
}

/**
 * The accounting-export seam (step 3.3) — e.g. QuickBooks/Xero — for
 * pushing a finalized payroll run's journal entries or an approved expense
 * claim into an external ledger. The SAME Symbol-token + interface +
 * `{provide, useClass}` shape as `AUTH_PROVIDER`/`BANK_EXPORT_ADAPTER`/
 * `BIOMETRIC_DEVICE_ADAPTER`. `NoopAccountingAdapter` (bound today) is a
 * dev/reference implementation only — a real QuickBooks/Xero OAuth
 * integration implements this interface and changes only the DI binding in
 * `accounting.module.ts`, per this step's brief ("interfaces + at least
 * stubs, not full vendor builds").
 */
export interface AccountingAdapter {
  readonly provider: string;
  exportPayrollRun(run: PayrollRun): Promise<AccountingExportResult>;
  exportExpenseClaim(claim: ExpenseClaim): Promise<AccountingExportResult>;
}
