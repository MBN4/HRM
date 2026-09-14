import type { Prisma, PrismaClient } from '@prisma/client';
import { type CountryPackConfig, countryPackConfigSchema } from '@hrm/shared';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The reference Country Packs: USA (the hardest case — multi-layer tax, no
 * income-tax-free statutory contribution), Qatar (no income tax,
 * end-of-service gratuity instead of a pension withholding, RTL Arabic), and
 * Pakistan (added in step 3.5.4 — see docs/conventions/pakistan-pack.md —
 * PKR/Sat-Sun weekend/RTL Urdu/a real progressive income tax + EOBI +
 * Provident Fund, replacing the ad-hoc PK test pack 3.5.2's benefits e2e
 * suite created directly and never seeded here). They exist to prove the
 * SAME schema drives totally different behavior, not as certified legal/tax
 * guidance — every number below is illustrative and rounded for a reference
 * implementation; a real deployment must have its country packs authored/
 * reviewed by whoever owns legal/payroll compliance for that market. The
 * Pakistan pack carries this further with explicit "VERIFY:" comments on
 * every legally-sensitive figure — see its own doc comment below.
 *
 * All three configs are validated against `countryPackConfigSchema` before
 * this module ever writes them, so a mistake here fails loudly at seed time
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

// ---------------------------------------------------------------------------
// PAKISTAN — see docs/conventions/pakistan-pack.md for the full write-up.
//
// ============================================================================
// COMPLIANCE BOUNDARY — READ THIS BEFORE USING THIS PACK FOR REAL PAYROLL.
//
// This pack's STRUCTURE (which brackets/components exist, how they combine,
// what's required at onboarding) is production-shaped and ready to use.
// Every LEGALLY-SENSITIVE NUMBER in it — income tax slab thresholds/rates,
// EOBI contribution rates/wage ceiling, Provident Fund rates — is a
// PLACEHOLDER, deliberately shaped like real Pakistani payroll law so the
// FORMULA is correct, but NOT verified against current FBR/EOBI notifications
// or a specific employer's actual PF scheme. Every such value below carries
// its own "VERIFY:" comment. **A qualified Pakistani tax/payroll professional
// MUST review and confirm every VERIFY-flagged figure against the current
// Finance Act / FBR withholding tables / EOBI Act (as amended) / the client's
// own PF trust deed before this pack is used to run real payroll** — exactly
// THE BOUNDARY payroll.md/benefits.md already state for every pack in this
// system, made concrete here for a real client engagement.
// ============================================================================
export const PAKISTAN_PACK: CountryPackConfig = {
  locale: {
    currencyCode: 'PKR',
    currencySymbol: 'Rs',
    numberFormat: 'ur-PK',
    dateFormat: 'DD/MM/YYYY',
    // Urdu — proving the RTL wiring covers more than Qatar's Arabic: `ur` is
    // already in @hrm/shared's RTL_LANGUAGES whitelist (packages/shared/src/i18n/rtl.ts),
    // and `rtl: true` below is the AUTHORITATIVE signal every renderer
    // actually uses (see docs/conventions/i18n-timezone-rtl.md) — the
    // whitelist is only a fallback for a bare language code with no pack
    // attached.
    defaultLanguage: 'ur',
    rtl: true,
    // Pakistan's work week runs Monday-Friday (Saturday/Sunday weekend, see
    // workingTime below) — MONDAY is the correct first-day-of-week for this
    // pack, a genuinely different choice from both existing reference packs
    // (which both use SUNDAY despite one of them having a Fri/Sat weekend),
    // proving this field is real per-pack data, not a copy-pasted default.
    firstDayOfWeek: 'MONDAY',
  },
  workingTime: {
    // Common Pakistani office-sector standard; provincial Shops & Establishments
    // Ordinances (Sindh/Punjab/KPK/Balochistan/Islamabad) and the Factories
    // Act 1934 can vary this by sector/province — VERIFY: confirm the
    // applicable ordinance for this employer's actual sector/province before
    // go-live.
    standardWeeklyHours: 40,
    // The common Pakistani working week — Saturday/Sunday off. A client on a
    // different week (e.g. a factory running Sunday-Thursday) sets this via
    // the existing tenant `workingTime` override (see country-packs.md's
    // two-layer override model) — no pack change needed for that case.
    weekendDays: ['SATURDAY', 'SUNDAY'],
    overtimeRules: {
      dailyThresholdHours: 8,
      // VERIFY: PK overtime multiplier — the Factories Act 1934 is commonly
      // cited as requiring double-rate (2x) overtime pay for factory workers;
      // provincial Shops & Establishments law may differ for office-sector
      // employees. Confirm the applicable law for this employer before go-live.
      multiplier: 2.0,
    },
  },
  // VERIFY: illustrative leave-day counts only. Real minimums vary by
  // province (each has its own Shops & Establishments Ordinance) and by
  // whether the employer falls under the Factories Act 1934 instead —
  // commonly-cited figures (annual/casual/sick leave after a qualifying
  // period of service, ~90-180 days maternity depending on province/year,
  // no uniform federal paternity-leave law) are used here as a reasonable
  // starting point, NOT a specific province's confirmed minimum. Confirm
  // against the applicable provincial ordinance before go-live.
  leaveDefaults: { annualDays: 14, sickDays: 8, maternityDays: 90, paternityDays: 0 },
  publicHolidays: {
    '2026': [
      // Fixed-date national holidays — these dates don't move year to year.
      { date: '2026-02-05', name: 'Kashmir Solidarity Day' },
      { date: '2026-03-23', name: 'Pakistan Day' },
      { date: '2026-05-01', name: 'Labour Day' },
      { date: '2026-08-14', name: 'Independence Day' },
      { date: '2026-11-09', name: 'Iqbal Day' },
      { date: '2026-12-25', name: 'Quaid-e-Azam Day' },
      // VERIFY (lunar/variable — MUST be reconfirmed every year): these four
      // are set by the Islamic (Hijri) lunar calendar and are officially
      // confirmed only after moon-sighting, typically announced by the
      // government days beforehand. The dates below are ASTRONOMICAL
      // PROJECTIONS for 2026 (±1-2 days is normal), seeded here only so the
      // calendar STRUCTURE has a full year to start from — replace with the
      // real, gazette-notified date as soon as it's announced, every year,
      // for every year.
      { date: '2026-03-20', name: 'Eid-ul-Fitr (VERIFY — approx., confirm via moon-sighting/govt. notification)' },
      { date: '2026-05-27', name: 'Eid-ul-Adha (VERIFY — approx., confirm via moon-sighting/govt. notification)' },
      { date: '2026-06-26', name: 'Ashura, 10 Muharram (VERIFY — approx., confirm via moon-sighting/govt. notification)' },
      { date: '2026-08-26', name: 'Eid Milad-un-Nabi (VERIFY — approx., confirm via moon-sighting/govt. notification)' },
    ],
  },
  tax: {
    layers: [
      {
        // Pakistan salaried-individual income tax — a single progressive
        // federal levy (unlike the US pack, Pakistan has no separate
        // provincial income tax layer to model). Structured as the SAME
        // generic PROGRESSIVE_BRACKETS algorithm the US federal layer
        // already uses — only the data differs.
        //
        // VERIFY: PK income tax slab FY2025-26 — these thresholds/rates are
        // ILLUSTRATIVE PLACEHOLDERS shaped like a real salaried-tax slab
        // (correct FORMULA, not a certified schedule) — confirm the actual
        // current-year slabs with an accountant/FBR (https://www.fbr.gov.pk)
        // before go-live. FBR salaried-tax slabs are revised almost every
        // Finance Act (annually, effective 1 July) — this pack's slab
        // thresholds/rates MUST be re-verified at every fiscal year-end,
        // not just once at go-live.
        name: 'income_tax',
        kind: 'PROGRESSIVE_BRACKETS',
        base: 'annualSalary',
        brackets: [
          { upTo: 600_000, rate: 0 },
          { upTo: 1_200_000, rate: 0.05 },
          { upTo: 2_200_000, rate: 0.15 },
          { upTo: 3_200_000, rate: 0.25 },
          { upTo: 4_100_000, rate: 0.3 },
          { upTo: null, rate: 0.35 },
        ],
      },
    ],
  },
  statutory: {
    components: [
      // Employees' Old-Age Benefits Institution — a wage-ceiling-based
      // scheme: modeled as PERCENTAGE-of-basicSalary capped at a monthly
      // wage ceiling (`cap`), the same generic algorithm/shape the US pack's
      // FICA social-security layer already uses for its OWN wage-base cap —
      // `computeStatutoryComponent`'s existing, unmodified PERCENTAGE+cap
      // handling (min(basicSalary, cap) * rate) needed no engine change to
      // support this. Real EOBI mechanics have historically been closer to
      // "a percentage of the statutory MINIMUM wage" than of the employee's
      // actual basic salary — this pack's PERCENTAGE+cap shape is a
      // reasonable structural approximation, not a literal transcription of
      // the EOBI Act; confirm the applicable computation with EOBI/an
      // accountant.
      //
      // VERIFY: EOBI employee/employer contribution rates + monthly wage
      // ceiling — figures below are illustrative placeholders (rates
      // consistent with the ad-hoc 3.5.2 test pack this replaces: 1%
      // employee / 5% employer). Confirm the CURRENT rates and wage ceiling
      // via the latest EOBI notification (https://eobi.gov.pk) before go-live.
      {
        name: 'eobi_employee',
        appliesTo: 'EMPLOYEE',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.01,
        cap: 29_000,
      },
      {
        name: 'eobi_employer',
        appliesTo: 'EMPLOYER',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.05,
        cap: 29_000,
      },
      // Provident Fund — commonly employer-policy-defined (per the Provident
      // Funds Act 1925 / a specific PF trust deed) rather than a single
      // universal statutory percentage; modeled here as a symmetric
      // employee/employer PERCENTAGE-of-basicSalary pair, the same
      // two-component "each side may differ" shape the Qatar pack's GRSIA
      // pension already establishes (see docs/conventions/benefits.md).
      //
      // VERIFY: Provident Fund employee/employer rates are ILLUSTRATIVE
      // ONLY — confirm the SPECIFIC scheme/trust-deed rate that applies to
      // this employer (rates commonly range ~8-10% of basic salary in
      // practice, but this is company-policy-dependent, not a fixed law).
      {
        name: 'provident_fund_employee',
        appliesTo: 'EMPLOYEE',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.0833,
      },
      {
        name: 'provident_fund_employer',
        appliesTo: 'EMPLOYER',
        kind: 'PERCENTAGE',
        base: 'basicSalary',
        rate: 0.0833,
      },
    ],
  },
  // CNIC (Computerized National Identity Card, NADRA) — Pakistan's
  // equivalent of the US pack's SSN / the Qatar pack's QATAR_ID. NTN
  // (National Tax Number, FBR) mirrors the US pack's W4 slot — a
  // tax-withholding-related identifier captured at onboarding, analogous
  // pairing to ["SSN","W4"].
  requiredEmployeeFields: ['CNIC', 'NTN'],
  payslipTemplate: {
    language: 'ur',
    lineItems: [
      { key: 'basic', label: 'بنیادی تنخواہ' },
      { key: 'gross', label: 'مجموعی تنخواہ' },
      { key: 'income_tax', label: 'انکم ٹیکس' },
      { key: 'eobi_employee', label: 'ای او بی آئی' },
      { key: 'provident_fund_employee', label: 'پراویڈنٹ فنڈ' },
      { key: 'net', label: 'خالص تنخواہ' },
    ],
  },
  payrollMode: 'CALCULATE',
  // No dedicated major cloud region serves Pakistan directly; `me-south-1`
  // (Bahrain) is the nearest already-used regional hint in this codebase.
  // Advisory only, per this field's own schema doc — never a hard
  // data-residency guarantee. FLAG FOR PHASE 6.1: some Pakistani sectors
  // (banking/telecom, under State Bank of Pakistan and PTA data-localization
  // rules) have real data-residency requirements that a future
  // data-residency feature would need to enforce properly — not implemented
  // here, tracked as a Phase 6.1 concern.
  hostingRegionHint: 'me-south-1',
};

const REFERENCE_PACKS: Record<string, CountryPackConfig> = {
  US: USA_PACK,
  QA: QATAR_PACK,
  PK: PAKISTAN_PACK,
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
