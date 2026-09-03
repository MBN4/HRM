import { Injectable } from '@nestjs/common';
import type { PayrollRun } from '@hrm/db';
import { NACHA_STUB_BANK_EXPORT_FORMAT } from '../payroll.constants';
import type { BankExportAdapter, BankExportFile, BankExportLineInput } from './bank-export-adapter.interface';

/**
 * HONEST STUB — proves `BankExportAdapterRegistry` genuinely selects a
 * DIFFERENT adapter per `PayrollRun.bankExportFormat`, NOT a real NACHA
 * file. A real NACHA implementation needs the actual fixed-width Batch
 * Header/Entry Detail/Batch Control/File Control record layout per NACHA
 * Operating Rules — deliberately not attempted here, the same
 * "documented, deliberate gap" posture docs/conventions/payroll.md already
 * takes for bank export having only one reference format.
 */
@Injectable()
export class NachaStubBankExportAdapter implements BankExportAdapter {
  generate(run: PayrollRun, lines: BankExportLineInput[]): BankExportFile {
    const body = Buffer.from(
      `NACHA_STUB — NOT a real NACHA file. Run ${run.id}, ${lines.length} line(s), currency ${run.currencyCode}.\n`,
      'utf8',
    );
    return {
      format: NACHA_STUB_BANK_EXPORT_FORMAT,
      fileName: `payroll-${run.id}-bank-export-nacha-stub.txt`,
      contentType: 'text/plain',
      body,
    };
  }
}
