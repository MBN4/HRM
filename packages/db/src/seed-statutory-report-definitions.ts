import type { Prisma, PrismaClient } from '@prisma/client';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The statutory/government reporting CATALOG (step 3.5.4) — see
 * docs/conventions/statutory-reporting.md. Global, RLS-exempt reference
 * data, the SAME posture `seed-country-packs.ts` already establishes for
 * `CountryPack`: these rows describe WHICH reports exist for a country and
 * WHAT PERIOD they cover, never how to compute one — the actual
 * finalized-payroll-run aggregation lives in
 * `apps/api/src/statutory-reporting/generators/*`, one small generator
 * function per `reportCode`, registered in `STATUTORY_REPORT_GENERATORS`.
 * Adding a new country's reports is exactly this: seed new definition rows
 * + implement/register their generators — never a change to the register/
 * queue/PDF/CSV/RBAC framework those generators run inside.
 *
 * PAKISTAN IS THE FIRST CONCRETE COUNTRY. Every `complianceNote` below is a
 * VERIFY-placeholder, the SAME discipline `PAKISTAN_PACK` (seed-country-packs.ts)
 * already holds itself to for legally-sensitive FIGURES: these reports'
 * STRUCTURE (which per-employee fields a filing needs — CNIC/NTN, gross pay,
 * tax withheld, statutory contributions) is production-shaped, but the exact
 * CURRENT form layout, field requirements, and submission channel/file
 * format for each filing must be confirmed against FBR / EOBI / the
 * relevant provincial authority before it is ever actually filed. Do not
 * treat a generated report as pre-cleared for submission.
 */
export const PAKISTAN_STATUTORY_REPORT_DEFINITIONS = [
  {
    countryCode: 'PK',
    reportCode: 'PK_INCOME_TAX_WITHHOLDING',
    name: 'Monthly income tax withholding statement',
    description:
      'Per-employee income tax withheld from salary for the period (CNIC/NTN, gross pay, tax withheld), aggregated from finalized payroll runs — the periodic withholding statement filed with the Federal Board of Revenue (FBR).',
    periodType: 'MONTHLY' as const,
    outputFormats: ['PDF', 'CSV'],
    complianceNote:
      'VERIFY: FBR currently expects monthly withholding statements filed electronically via IRIS in a prescribed field/file format — confirm the CURRENT field set, filing deadline, and submission channel with FBR/an accountant before filing. This report\'s per-employee CNIC/NTN/gross-pay/tax-withheld structure is production-shaped, not a certified reproduction of FBR\'s current prescribed form.',
  },
  {
    countryCode: 'PK',
    reportCode: 'PK_EOBI_CONTRIBUTION',
    name: 'EOBI monthly contribution return',
    description:
      'Per-employee employer + employee EOBI contributions for the period, wage-ceiling applied, aggregated from finalized payroll runs — the periodic contribution return filed with the Employees\' Old-Age Benefits Institution (EOBI).',
    periodType: 'MONTHLY' as const,
    outputFormats: ['PDF', 'CSV'],
    complianceNote:
      'VERIFY: EOBI\'s current contribution-return field set, wage ceiling, and submission process (eobi.gov.pk) before filing — this report\'s per-employee CNIC/wage/employee-contribution/employer-contribution structure is production-shaped, not a certified reproduction of EOBI\'s current prescribed return.',
  },
  {
    countryCode: 'PK',
    reportCode: 'PK_PROVIDENT_FUND_CONTRIBUTION',
    name: 'Provident Fund contribution report',
    description:
      'Per-employee employer + employee Provident Fund contributions for the period, aggregated from finalized payroll runs — an internal/trustee-facing report, not a direct government filing (applicability and the exact scheme depend on the employer\'s own PF trust deed).',
    periodType: 'MONTHLY' as const,
    outputFormats: ['PDF', 'CSV'],
    complianceNote:
      'VERIFY: whether a Provident Fund scheme applies at all, and its exact contribution rates/reporting cadence, against the specific employer\'s own PF trust deed — this report only reflects whatever the resolved Country Pack\'s statutory components declare, which are themselves VERIFY-placeholders (see docs/conventions/pakistan-pack.md).',
  },
  {
    countryCode: 'PK',
    reportCode: 'PK_ANNUAL_SALARY_TAX_STATEMENT',
    name: 'Annual salary & tax withholding statement',
    description:
      'Per-employee total gross salary paid and total income tax withheld across every finalized payroll run in the year, with CNIC/NTN — the annual statement of income tax deducted from salary an employer files/issues.',
    periodType: 'ANNUAL' as const,
    outputFormats: ['PDF', 'CSV'],
    complianceNote:
      'VERIFY: the current annual statement\'s exact form/field requirements and filing deadline (commonly referenced as the employer\'s annual statement of tax deducted from salary under the Income Tax Ordinance, 2001, as amended) with FBR/an accountant before filing — this report\'s per-employee annual gross/tax-withheld totals are production-shaped, not a certified reproduction of the current form.',
  },
];

/**
 * Upserts every country's statutory report definitions — validated
 * structurally by the DB's own NOT NULL/enum constraints (there is no
 * separate zod schema for this catalog, unlike `CountryPackConfig`: a
 * report definition has no legally-sensitive computed FIGURE for a schema
 * to validate, only descriptive metadata). Idempotent, safe to call every
 * time the app boots/tests set up — the SAME `upsert`-by-natural-key
 * pattern `seedCountryPacks` already establishes.
 */
export async function seedStatutoryReportDefinitions(client: Client): Promise<void> {
  for (const definition of PAKISTAN_STATUTORY_REPORT_DEFINITIONS) {
    await client.statutoryReportDefinition.upsert({
      where: { countryCode_reportCode: { countryCode: definition.countryCode, reportCode: definition.reportCode } },
      update: {
        name: definition.name,
        description: definition.description,
        periodType: definition.periodType,
        outputFormats: definition.outputFormats,
        complianceNote: definition.complianceNote,
        isActive: true,
      },
      create: { ...definition, isActive: true },
    });
  }
}
