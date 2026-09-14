import { z } from 'zod';

/**
 * Statutory / government reporting (step 3.5.4) — see
 * docs/conventions/statutory-reporting.md. This module GENERATES periodic
 * government filing forms/exports FROM already-finalized `PayrollRun` data
 * (2.1) — it never calculates a figure itself (that's the pack/engine's
 * job, see country-pack.validator.ts/payroll.validator.ts). This schema is
 * deliberately thin: unlike `CountryPackConfig`, a report DEFINITION has no
 * legally-sensitive computed figure for a schema to validate — see
 * `packages/db/src/seed-statutory-report-definitions.ts` for the catalog
 * itself. `reportCode`/`periodYear`/(`periodMonth`|`periodQuarter`) here are
 * intentionally not cross-validated against a specific report's own
 * `periodType` at this layer — that's a service-layer check
 * (`StatutoryReportService.generate`) against the resolved
 * `StatutoryReportDefinition` row, the same "this schema can't know what a
 * runtime DB row says" posture `runPayrollSchema` already takes for
 * `branchId`.
 */

export const STATUTORY_REPORT_PERIOD_TYPES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export type StatutoryReportPeriodTypeKey = (typeof STATUTORY_REPORT_PERIOD_TYPES)[number];

export const STATUTORY_REPORT_OUTPUT_FORMATS = ['PDF', 'CSV'] as const;
export type StatutoryReportOutputFormat = (typeof STATUTORY_REPORT_OUTPUT_FORMATS)[number];

export const generateStatutoryReportSchema = z
  .object({
    branchId: z.string().uuid(),
    reportCode: z.string().min(1).max(64),
    periodYear: z.number().int().min(2000).max(2100),
    periodMonth: z.number().int().min(1).max(12).optional(),
    periodQuarter: z.number().int().min(1).max(4).optional(),
  })
  .strict();
export type GenerateStatutoryReportInput = z.infer<typeof generateStatutoryReportSchema>;

/** Shape returned by `GET /statutory-reports/definitions` — the catalog for a resolved branch's country. */
export interface StatutoryReportDefinitionDto {
  id: string;
  countryCode: string;
  reportCode: string;
  name: string;
  description: string;
  periodType: StatutoryReportPeriodTypeKey;
  outputFormats: string[];
  complianceNote: string;
}
