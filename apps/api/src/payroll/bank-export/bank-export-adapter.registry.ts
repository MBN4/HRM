import { Injectable } from '@nestjs/common';
import type { BankExportAdapter } from './bank-export-adapter.interface';

export const BANK_EXPORT_ADAPTER_REGISTRY = Symbol('BANK_EXPORT_ADAPTER_REGISTRY');

/**
 * Step 3.3 — formalizes the bank-export seam (docs/conventions/payroll.md's
 * "one reference CSV format, no per-country selection" gap) into a
 * genuinely PLUGGABLE choice, additive on top of the EXISTING single
 * `BANK_EXPORT_ADAPTER` binding (untouched — still the default when a run
 * doesn't specify a format, so every pre-3.3 run/test behaves identically).
 * `PayrollBankExportService` resolves `PayrollRun.bankExportFormat`
 * (nullable seam column) against this registry, falling back to the
 * default adapter when unset. Registering a real country-specific format
 * (NACHA, SEPA, ...) later is calling `.register(format, adapter)` once
 * from `payroll.module.ts` — no change to `PayrollBankExportService`, the
 * interface, or the payroll engine.
 */
@Injectable()
export class BankExportAdapterRegistry {
  private readonly adaptersByFormat = new Map<string, BankExportAdapter>();

  register(format: string, adapter: BankExportAdapter): void {
    this.adaptersByFormat.set(format, adapter);
  }

  resolve(format: string): BankExportAdapter | undefined {
    return this.adaptersByFormat.get(format);
  }
}
