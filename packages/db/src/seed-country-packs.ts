import type { Prisma, PrismaClient } from '@prisma/client';
import { type CountryPackConfig, countryPackConfigSchema } from '@hrm/shared';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The two reference Country Packs required by step 0.5: USA (the hardest
 * case — multi-layer tax, no income-tax-free statutory contribution) and
 * Qatar (no income tax, end-of-service gratuity instead of a pension
 * withholding, RTL Arabic). They exist to prove the SAME schema drives
 * totally different behavior, not as certified legal/tax guidance — every
 * number below is illustrative and rounded for a reference implementation;
 * a real deployment must have its country packs authored/reviewed by
 * whoever owns legal/payroll compliance for that market.
 *
 * Both configs are validated against `countryPackConfigSchema` before this
 * module ever writes them, so a mistake here fails loudly at seed time
 * rather than producing a CountryPack row that quietly can't resolve.
 */
export const USA_PACK: CountryPackConfig = {
  locale: {
    currencyCode: 'USD',
    currencySymbol: '$',
    numberFormat: 'en-US',
    dateFormat: 'MM/DD/YYYY',
    defaultLanguage: 'en',
    rtl: false,
    firstDayOfWeek: 'SUNDAY',
  },
  workingTime: {
    standardWeeklyHours: 40,
    weekendDays: ['SATURDAY', 'SUNDAY'],
    overtimeRules: { dailyThresholdHours: 8, weeklyThresholdHours: 40, multiplier: 1.5 },
  },
  leaveDefaults: { annualDays: 10, sickDays: 5, maternityDays: 0, paternityDays: 0 },
  publicHolidays: {
    '2026': [
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-07-04', name: 'Independence Day' },
      { date: '2026-11-26', name: 'Thanksgiving Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
    ],
  },
  tax: {
    layers: [
      {
        name: 'federal_income_tax',
        kind: 'PROGRESSIVE_BRACKETS',
        base: 'annualSalary',
        // Illustrative, rounded single-filer bands — not the certified IRS schedule.
        brackets: [
          { upTo: 11_600, rate: 0.1 },
          { upTo: 47_150, rate: 0.12 },
          { upTo: 100_525, rate: 0.22 },
          { upTo: 191_950, rate: 0.24 },
          { upTo: null, rate: 0.32 },
        ],
      },
      {
        // Illustrative flat state rate, standing in for "whichever state the branch is in" — real
        // per-state variation is out of scope for this reference pack.
        name: 'state_income_tax',
        kind: 'FLAT_RATE',
        base: 'annualSalary',
        rate: 0.05,
      },
      {
        name: 'fica_social_security',
        kind: 'FLAT_RATE',
        base: 'annualSalary',
        rate: 0.062,
        cap: 168_600,
      },
      {
        name: 'fica_medicare',
        kind: 'FLAT_RATE',
        base: 'annualSalary',
        rate: 0.0145,
      },
    ],
  },
  statutory: {
    components: [
      {
        // Federal Unemployment Tax Act — employer-paid, illustrative rate/cap.
        name: 'futa',
        appliesTo: 'EMPLOYER',
        kind: 'PERCENTAGE',
        base: 'annualSalary',
        rate: 0.006,
        cap: 7_000,
      },
      {
        // State Disability Insurance — illustrative EMPLOYEE-side statutory
        // withholding (several US states, e.g. California, mandate one).
        // Added in step 3.5.2 (Benefits administration) specifically to
        // demonstrate an EMPLOYEE-side statutory component on the US pack —
        // FUTA above is employer-only, so this is the pack's first employee
        // withholding outside `tax.layers`. Computed by the SAME unmodified
        // `computeStatutoryComponent` PayrollEngineService already calls for
        // every statutory component — no engine change was needed for this
        // addition to take effect. See docs/conventions/benefits.md.
        name: 'state_disability_insurance',
        appliesTo: 'EMPLOYEE',
        kind: 'PERCENTAGE',
        base: 'annualSalary',
        rate: 0.009,
        cap: 153_164,
      },
    ],
  },
  requiredEmployeeFields: ['SSN', 'W4'],
  payslipTemplate: {
    language: 'en',
    lineItems: [
      { key: 'gross', label: 'Gross Pay' },
      { key: 'federal_income_tax', label: 'Federal Tax' },
      { key: 'state_income_tax', label: 'State Tax' },
      { key: 'fica_social_security', label: 'Social Security' },
      { key: 'fica_medicare', label: 'Medicare' },
      { key: 'net', label: 'Net Pay' },
    ],
  },
  payrollMode: 'CALCULATE',
  hostingRegionHint: 'us-east-1',
};

export const QATAR_PACK: CountryPackConfig = {
  locale: {
    currencyCode: 'QAR',
    currencySymbol: 'ر.ق',
    numberFormat: 'ar-QA',
    dateFormat: 'DD/MM/YYYY',
    defaultLanguage: 'ar',
    rtl: true,
    firstDayOfWeek: 'SUNDAY',
  },
  workingTime: {
    standardWeeklyHours: 48,
    weekendDays: ['FRIDAY', 'SATURDAY'],
    overtimeRules: { dailyThresholdHours: 8, multiplier: 1.25 },
  },
  // Qatar Labour Law minimums, illustrative: 3 weeks (~21 days) annual leave under 5 years'
  // service, 2 weeks full pay + 4 weeks half pay sick leave (simplified to one numeric figure
  // here), ~50 days maternity leave, 3 days paternity leave.
  leaveDefaults: { annualDays: 21, sickDays: 14, maternityDays: 50, paternityDays: 3 },
  publicHolidays: {
    '2026': [
      { date: '2026-02-11', name: 'National Sports Day' },
      { date: '2026-12-18', name: 'Qatar National Day' },
    ],
  },
  // No personal income tax in Qatar.
  tax: { layers: [] },
  statutory: {
    components: [
      {
        // End-of-service gratuity: illustrative 3 weeks' basic salary per year for the first 5
        // years of service, 4 weeks' basic salary per year beyond that — employer-funded, no
        // employee withholding.
        name: 'end_of_service_gratuity',
        appliesTo: 'EMPLOYER',
        kind: 'TIERED_BY_YEARS_OF_SERVICE',
        base: 'basicSalary',
        tiers: [
          { upToYears: 5, weeksPerYear: 3 },
          { upToYears: null, weeksPerYear: 4 },
        ],
      },
      {
        // GRSIA — Qatar's General Retirement and Social Insurance Authority
        // pension scheme (applies, in reality, only to Qatari national
        // employees; modeled here for every employee on this reference
        // pack, illustrative/simplified for demonstration purposes, not
        // certified guidance). Previously an explicitly-flagged gap in this
        // reference pack ("deliberately out of scope") — added in step
        // 3.5.2 (Benefits administration) as two asymmetric PERCENTAGE
        // components (illustrative rates: 5% employee, 10% employer, of
        // basic salary — a real scheme's employee/employer rates typically
        // differ, which a single `BOTH` component can't express since it
        // applies one rate to both sides equally), proving Benefits'
        // statutory surface needs no engine change: `PayrollEngineService`
        // already applies every `statutory.components` entry generically,
        // employee and employer sides alike. See
        // docs/conventions/benefits.md.
        name: 'grsia_pension_employee',
        appliesTo: 'EMPLOYEE',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.05,
      },
      {
        name: 'grsia_pension_employer',
        appliesTo: 'EMPLOYER',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.1,
      },
    ],
  },
  requiredEmployeeFields: ['QATAR_ID', 'VISA_SPONSORSHIP'],
  payslipTemplate: {
    language: 'ar',
    lineItems: [
      { key: 'basic', label: 'الراتب الأساسي' },
      { key: 'allowances', label: 'البدلات' },
      { key: 'gross', label: 'الإجمالي' },
      { key: 'net', label: 'صافي الراتب' },
    ],
  },
  payrollMode: 'CALCULATE',
  hostingRegionHint: 'me-south-1',
};

const REFERENCE_PACKS: Record<string, CountryPackConfig> = {
  US: USA_PACK,
  QA: QATAR_PACK,
};

/**
 * Idempotent (safe to re-run): upserts version 1 of each reference pack by
 * its `(countryCode, version)` unique constraint. This is also the pattern
 * a future admin-authored pack (or a new version of one of these) should
 * follow — validate against `countryPackConfigSchema`, then upsert.
 */
export async function seedCountryPacks(client: Client): Promise<void> {
  for (const [countryCode, config] of Object.entries(REFERENCE_PACKS)) {
    const validated = countryPackConfigSchema.parse(config);
    await client.countryPack.upsert({
      where: { countryCode_version: { countryCode, version: 1 } },
      update: { config: validated, isActive: true },
      create: { countryCode, version: 1, isActive: true, config: validated },
    });
  }
}
