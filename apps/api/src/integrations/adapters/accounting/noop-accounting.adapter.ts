import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ExpenseClaim, PayrollRun } from '@hrm/db';
import type { AccountingAdapter, AccountingExportResult } from './accounting-adapter.interface';

/**
 * Dev/reference implementation only — logs the export and returns a
 * synthetic reference id, tagged so tests can assert THIS path (not a real
 * ledger call) is what ran, the SAME "stub, tagged, no real math/I/O"
 * posture `StubPayrollProviderAdapter` (2.1) already establishes for its
 * own category.
 */
@Injectable()
export class NoopAccountingAdapter implements AccountingAdapter {
  readonly provider = 'noop';
  private readonly logger = new Logger('AccountingAdapter(noop)');

  async exportPayrollRun(run: PayrollRun): Promise<AccountingExportResult> {
    this.logger.log(`[NOOP] would export payroll run "${run.id}" to an external ledger.`);
    return this.result();
  }

  async exportExpenseClaim(claim: ExpenseClaim): Promise<AccountingExportResult> {
    this.logger.log(`[NOOP] would export expense claim "${claim.id}" to an external ledger.`);
    return this.result();
  }

  private result(): AccountingExportResult {
    return { externalReference: `noop-${randomUUID()}`, exportedAt: new Date().toISOString() };
  }
}
