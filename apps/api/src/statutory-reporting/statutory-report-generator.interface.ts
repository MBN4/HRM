import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';

export const STATUTORY_REPORT_GENERATOR_REGISTRY = Symbol('STATUTORY_REPORT_GENERATOR_REGISTRY');

/** One column of a generated report's per-employee table — `key` maps a row's `values` entry, `label` is the DEFAULT (English) header; a generator may return a country-appropriate `label` directly (e.g. Urdu) instead. */
export interface StatutoryReportColumn {
  key: string;
  label: string;
}

export interface StatutoryReportEmployeeIdentity {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** From `Employee.statutoryFields` (the pack's own opaque `requiredEmployeeFields` keys) — never re-validated here, just read. */
  cnic: string | null;
  ntn: string | null;
}

export interface StatutoryReportRow {
  identity: StatutoryReportEmployeeIdentity;
  /** column key -> amount, in the run's OWN currency — never recomputed, only read off `PayrollRunLine.componentBreakdown`/`grossPay`/`netPay`. */
  values: Record<string, number>;
}

/** The fully-aggregated, ready-to-render report — the ONE shape both `StatutoryReportPdfService` and `StatutoryReportCsvService` render from, so a generator never needs to know about PDF/CSV specifics. */
export interface StatutoryReportData {
  reportCode: string;
  reportName: string;
  countryCode: string;
  currencyCode: string;
  /** Human-readable period, e.g. "2026-06" / "2026-Q2" / "2026". */
  periodLabel: string;
  language: string;
  columns: StatutoryReportColumn[];
  rows: StatutoryReportRow[];
  /** column key -> summed total across every row — shown as a footer line and stored on `GeneratedReport.summary`. */
  totals: Record<string, number>;
}

export interface StatutoryReportGenerationParams {
  tenantId: string;
  branchId: string;
  branchName: string;
  countryCode: string;
  currencyCode: string;
  /** The resolved Country Pack's own `payslipTemplate.language` — drives RTL alignment/label language in the rendered PDF, the SAME `isRtlLanguage` mechanism `PayslipPdfService` already uses. */
  language: string;
  periodYear: number;
  periodMonth?: number;
  periodQuarter?: number;
}

/**
 * One small generator per `reportCode` — see
 * docs/conventions/statutory-reporting.md. Reads STRICTLY from already-
 * FINALIZED `PayrollRun`/`PayrollRunLine` data (see
 * `REPORTABLE_PAYROLL_RUN_STATUSES`) plus `Employee`; it never calls
 * `PayrollEngineService`/the rules engine and never recomputes a figure.
 * Adding a new country's report is implementing this interface once per
 * report and registering it in `statutory-reporting.module.ts` — no change
 * to the register/queue/PDF/CSV/controller framework.
 */
export interface StatutoryReportGenerator {
  generate(tx: Prisma.TransactionClient, params: StatutoryReportGenerationParams): Promise<StatutoryReportData>;
}

/**
 * A plain code -> generator lookup, the SAME shape `BankExportAdapterRegistry`
 * (payroll's own bank-export seam, step 3.3) already establishes for a
 * near-identical "pick an implementation by a string key from DB/catalog
 * data" problem — reused here rather than inventing a second registry shape.
 */
@Injectable()
export class StatutoryReportGeneratorRegistry {
  private readonly generatorsByCode = new Map<string, StatutoryReportGenerator>();

  register(reportCode: string, generator: StatutoryReportGenerator): void {
    this.generatorsByCode.set(reportCode, generator);
  }

  resolve(reportCode: string): StatutoryReportGenerator | undefined {
    return this.generatorsByCode.get(reportCode);
  }
}
