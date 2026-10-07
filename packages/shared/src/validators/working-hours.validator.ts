import { z } from 'zod';

/**
 * Working-hours policy (step 8.1, Part 1) — see docs/conventions/working-hours.md.
 * The policy is the expected schedule; the member's timezone comes from their
 * BRANCH and is never part of it.
 */

export const WORKING_HOURS_SCOPES = ['COMPANY', 'TEAM', 'MEMBER'] as const;
export type WorkingHoursScopeName = (typeof WORKING_HOURS_SCOPES)[number];

/** Where an effective policy came from, most specific first. `COUNTRY_PACK` = no policy row applied. */
export const WORKING_HOURS_SOURCES = ['MEMBER', 'TEAM', 'COMPANY', 'COUNTRY_PACK'] as const;
export type WorkingHoursSource = (typeof WORKING_HOURS_SOURCES)[number];

/** Defaults used when a Country Pack has to supply the fallback (it has no start time / break / grace of its own). */
export const WORKING_HOURS_DEFAULTS = { startTime: '09:00', breakHours: 1, graceMinutes: 15 } as const;

/** "HH:mm", 24-hour. */
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm, e.g. 09:00');

/** requiredHours = workHours + breakHours (so "8 work + 1 break" = 9). */
export function requiredHoursOf(workHours: number, breakHours: number): number {
  return Math.round((workHours + breakHours) * 100) / 100;
}

/** The half-day threshold when none is set: half of the required hours (8 work + 1 break -> 4.5). */
export function defaultHalfDayThreshold(workHours: number, breakHours: number): number {
  return Math.round((requiredHoursOf(workHours, breakHours) / 2) * 100) / 100;
}

const policyShape = z.object({
  startTime: hhmmSchema,
  workHours: z.number().gt(0, 'workHours must be positive').max(24),
  breakHours: z.number().min(0, 'breakHours cannot be negative').max(12),
  graceMinutes: z.number().int().min(0, 'graceMinutes cannot be negative').max(240).default(15),
  /** Optional; omitted/null = derive requiredHours / 2. When set it must be > 0 and < requiredHours. */
  halfDayThresholdHours: z.number().gt(0, 'halfDayThresholdHours must be positive').nullable().optional(),
});

function sane(v: z.infer<typeof policyShape>, ctx: z.RefinementCtx) {
  const required = requiredHoursOf(v.workHours, v.breakHours);
  if (required > 24) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['breakHours'], message: 'work + break hours cannot exceed 24' });
  }
  if (v.halfDayThresholdHours != null && v.halfDayThresholdHours >= required) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['halfDayThresholdHours'],
      message: `halfDayThresholdHours must be less than the required hours (${required})`,
    });
  }
}

export const upsertWorkingHoursPolicySchema = policyShape.strict().superRefine(sane);
export type UpsertWorkingHoursPolicyInput = z.infer<typeof upsertWorkingHoursPolicySchema>;

export const effectiveWorkingHoursQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  /** YYYY-MM-DD — echoed back; policies are not date-versioned yet (documented), so it does not change the result today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type EffectiveWorkingHoursQuery = z.infer<typeof effectiveWorkingHoursQuerySchema>;
