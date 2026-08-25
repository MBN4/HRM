import { z } from 'zod';
import { statutoryComponentSchema, taxLayerSchema } from './rules-engine.validator';

/**
 * The Country Pack schema — see /CLAUDE.md § Conventions → Country packs
 * for the full write-up. A CountryPack's `config` column (and, for the
 * overridable subset, a TenantCountryOverride's `overrides` column) is
 * validated against these schemas on every write AND every read (see
 * apps/api's CountryPackResolutionService) — a JSON column carries no
 * schema-level guarantee on its own.
 *
 * THE RULE: no module may ever branch on a country code. Every behavior
 * that differs by country (currency, weekend days, tax, statutory
 * contributions, required fields, ...) must be read from the resolved
 * effective config produced by CountryPackResolutionService, never
 * hardcoded as `if (countryCode === 'US')` anywhere else in the codebase.
 */

export const WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const localeSchema = z.object({
  /** ISO 4217, e.g. "USD", "QAR". */
  currencyCode: z.string().length(3),
  currencySymbol: z.string().min(1),
  /** An Intl.NumberFormat-compatible locale tag, e.g. "en-US", "ar-QA". */
  numberFormat: z.string().min(2),
  /** A display date-format token string, e.g. "MM/DD/YYYY", "DD/MM/YYYY". */
  dateFormat: z.string().min(1),
  /** BCP-47 language tag, e.g. "en", "ar". */
  defaultLanguage: z.string().min(2),
  rtl: z.boolean(),
  firstDayOfWeek: z.enum(WEEKDAYS),
});
export type LocaleConfig = z.infer<typeof localeSchema>;

export const overtimeRulesSchema = z.object({
  dailyThresholdHours: z.number().positive().optional(),
  weeklyThresholdHours: z.number().positive().optional(),
  /** e.g. 1.5 for time-and-a-half. */
  multiplier: z.number().positive(),
});
export type OvertimeRules = z.infer<typeof overtimeRulesSchema>;

export const workingTimeSchema = z.object({
  standardWeeklyHours: z.number().positive(),
  weekendDays: z.array(z.enum(WEEKDAYS)).min(1).max(6),
  overtimeRules: overtimeRulesSchema,
});
export type WorkingTimeConfig = z.infer<typeof workingTimeSchema>;

export const leaveDefaultsSchema = z.object({
  annualDays: z.number().nonnegative(),
  sickDays: z.number().nonnegative(),
  maternityDays: z.number().nonnegative(),
  paternityDays: z.number().nonnegative(),
});
export type LeaveDefaults = z.infer<typeof leaveDefaultsSchema>;

export const publicHolidaySchema = z.object({
  /** ISO 8601 calendar date, e.g. "2026-01-01". */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  name: z.string().min(1),
});
export type PublicHoliday = z.infer<typeof publicHolidaySchema>;

/** Keyed by four-digit calendar year, e.g. `{ "2026": [...] }`, seedable one year at a time. */
export const publicHolidaysSchema = z.record(z.string().regex(/^\d{4}$/), z.array(publicHolidaySchema));
export type PublicHolidaysCalendar = z.infer<typeof publicHolidaysSchema>;

export const taxConfigSchema = z.object({
  /** Multi-layer, e.g. [federal, state, FICA-social-security, FICA-medicare]. Empty = no income tax (e.g. Qatar). */
  layers: z.array(taxLayerSchema),
});
export type TaxConfig = z.infer<typeof taxConfigSchema>;

export const statutoryConfigSchema = z.object({
  components: z.array(statutoryComponentSchema),
});
export type StatutoryConfig = z.infer<typeof statutoryConfigSchema>;

export const payslipTemplateSchema = z.object({
  language: z.string().min(2),
  lineItems: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(1),
});
export type PayslipTemplate = z.infer<typeof payslipTemplateSchema>;

export const payrollModeSchema = z.enum(['CALCULATE', 'DELEGATE']);
export type PayrollMode = z.infer<typeof payrollModeSchema>;

export const countryPackConfigSchema = z.object({
  locale: localeSchema,
  workingTime: workingTimeSchema,
  leaveDefaults: leaveDefaultsSchema,
  publicHolidays: publicHolidaysSchema,
  tax: taxConfigSchema,
  statutory: statutoryConfigSchema,
  /** e.g. ["SSN", "W4"] for the US, ["QATAR_ID", "VISA_SPONSORSHIP"] for Qatar. Opaque keys — meaning lives in the future employee-fields module. */
  requiredEmployeeFields: z.array(z.string().min(1)),
  payslipTemplate: payslipTemplateSchema,
  payrollMode: payrollModeSchema,
  /** Advisory only — e.g. "us-east-1", "me-south-1" — never enforced as a hard data-residency boundary by this schema alone. */
  hostingRegionHint: z.string().min(1),
});
export type CountryPackConfig = z.infer<typeof countryPackConfigSchema>;

/**
 * The two-layer override model's whitelist: ONLY these sections may ever be
 * tenant-overridden, and each is a partial patch, not a full replacement.
 * `.strict()` means an override payload naming any other key (tax,
 * statutory, locale, payrollMode, ...) fails validation outright — those
 * are legal/compliance surfaces a tenant must never be able to touch.
 * Numeric bounds beyond "valid shape" (e.g. "a tenant may only grant MORE
 * leave than the legal floor, never less") are pack-relative and enforced
 * separately by apps/api's CountryPackResolutionService, not here — this
 * schema only knows the override in isolation, not the pack it applies to.
 */
export const tenantCountryOverrideSchema = z
  .object({
    leaveDefaults: leaveDefaultsSchema.partial(),
    workingTime: workingTimeSchema.partial(),
    requiredEmployeeFields: z.array(z.string().min(1)),
    payslipTemplate: payslipTemplateSchema.partial(),
  })
  .partial()
  .strict();
export type TenantCountryOverrideInput = z.infer<typeof tenantCountryOverrideSchema>;
