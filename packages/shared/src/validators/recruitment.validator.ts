import { z } from 'zod';
import { EMPLOYMENT_TYPES } from './employee.validator';

/**
 * The Recruitment (ATS) module's schema — see
 * docs/conventions/recruitment-lifecycle.md. Reuses `EMPLOYMENT_TYPES`
 * from `employee.validator.ts` as-is (a requisition/offer's employment
 * type IS the same closed catalog an `Employee` row uses — no reason for a
 * second one) rather than redefining it.
 */
export const createJobRequisitionSchema = z
  .object({
    title: z.string().min(1).max(200),
    branchId: z.string().uuid(),
    departmentId: z.string().uuid().optional(),
    designationId: z.string().uuid().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    headcount: z.number().int().min(1).default(1),
    justification: z.string().max(2000).optional(),
  })
  .strict();
export type CreateJobRequisitionInput = z.infer<typeof createJobRequisitionSchema>;

/** `publicSlug` is what the unauthenticated careers API resolves a posting by — URL-safe, lowercase, hyphenated. */
export const createJobPostingSchema = z
  .object({
    requisitionId: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(10000),
    publicSlug: z
      .string()
      .min(1)
      .max(150)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'publicSlug must be lowercase, alphanumeric, and hyphen-separated.'),
  })
  .strict();
export type CreateJobPostingInput = z.infer<typeof createJobPostingSchema>;

export const APPLICATION_STAGES = ['APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const;
export type ApplicationStageKey = (typeof APPLICATION_STAGES)[number];

export const updateApplicationStageSchema = z
  .object({
    stage: z.enum(APPLICATION_STAGES),
  })
  .strict();
export type UpdateApplicationStageInput = z.infer<typeof updateApplicationStageSchema>;

/** The PUBLIC careers "apply" endpoint's fields — submitted as multipart form fields alongside a `resume` file (see docs/conventions/recruitment-lifecycle.md → The public careers API). */
export const applyToPostingSchema = z
  .object({
    firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200),
    email: z.string().email(),
    phone: z.string().min(1).max(50).optional(),
  })
  .strict();
export type ApplyToPostingInput = z.infer<typeof applyToPostingSchema>;

export const createInterviewSchema = z
  .object({
    applicationId: z.string().uuid(),
    scheduledAt: z.coerce.date(),
    durationMinutes: z.number().int().positive().max(1440),
    interviewerUserIds: z.array(z.string().uuid()).min(1),
    location: z.string().max(500).optional(),
  })
  .strict();
export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;

export const SCORECARD_RECOMMENDATIONS = ['STRONG_YES', 'YES', 'NO', 'STRONG_NO'] as const;
export type ScorecardRecommendationKey = (typeof SCORECARD_RECOMMENDATIONS)[number];

export const submitScorecardSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    recommendation: z.enum(SCORECARD_RECOMMENDATIONS),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type SubmitScorecardInput = z.infer<typeof submitScorecardSchema>;

/** Money is `Decimal` at rest (see docs/conventions/payroll.md); a plain `number` at this API boundary, the same posture `compensationSchema`'s `baseSalary` already takes. */
export const createOfferSchema = z
  .object({
    applicationId: z.string().uuid(),
    branchId: z.string().uuid(),
    departmentId: z.string().uuid().optional(),
    designationId: z.string().uuid().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    proposedSalary: z.number().nonnegative(),
    salaryCurrency: z.string().length(3),
    proposedJoinDate: z.coerce.date(),
  })
  .strict();
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
