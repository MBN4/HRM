import { z } from 'zod';

/**
 * The Performance module's schema — see docs/conventions/performance.md.
 * Two genuinely new tenant-configurable concepts, both modeled as DATA
 * (validated here, stored as JSON) rather than a closed code-level enum,
 * per this step's explicit brief: `RatingLevel[]` (a rating scale's own
 * levels) and `AppraisalCycle.enabledReviewTypes`. `REVIEW_TYPES` itself
 * IS a closed, code-level catalog (SELF/MANAGER/PEER/UPWARD) — the same
 * "some things ARE a fixed, closed set" exception `LEAVE_TYPES`/
 * `CustomFieldType` already take elsewhere in this codebase; "360" is not
 * a fifth type, it is simply a cycle whose `enabledReviewTypes` includes
 * all four.
 */
export const REVIEW_TYPES = ['SELF', 'MANAGER', 'PEER', 'UPWARD'] as const;
export type ReviewTypeKey = (typeof REVIEW_TYPES)[number];

export const APPRAISAL_CYCLE_TYPES = ['ANNUAL', 'QUARTERLY', 'PROBATION'] as const;
export type AppraisalCycleTypeKey = (typeof APPRAISAL_CYCLE_TYPES)[number];

export const GOAL_LEVELS = ['COMPANY', 'TEAM', 'INDIVIDUAL'] as const;
export type GoalLevelKey = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const;
export type GoalStatusKey = (typeof GOAL_STATUSES)[number];

/** One level of a tenant-configurable rating scale — e.g. `{ value: 5, label: "Exceptional" }`. `value` is the numeric anchor calibration/distribution buckets group by. */
export const ratingLevelSchema = z
  .object({
    value: z.number(),
    label: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
  })
  .strict();
export type RatingLevel = z.infer<typeof ratingLevelSchema>;

export const createRatingScaleSchema = z
  .object({
    key: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    levels: z
      .array(ratingLevelSchema)
      .min(2, 'A rating scale needs at least two levels.')
      .refine((levels) => new Set(levels.map((level) => level.value)).size === levels.length, {
        message: 'Rating level values must be unique.',
      }),
  })
  .strict();
export type CreateRatingScaleInput = z.infer<typeof createRatingScaleSchema>;

export const createAppraisalCycleSchema = z
  .object({
    name: z.string().min(1).max(200),
    cycleType: z.enum(APPRAISAL_CYCLE_TYPES),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    ratingScaleKey: z.string().min(1),
    enabledReviewTypes: z.array(z.enum(REVIEW_TYPES)).min(1),
    /** Empty (the default) = every branch/department in the tenant is eligible. */
    eligibleBranchIds: z.array(z.string().uuid()).default([]),
    eligibleDepartmentIds: z.array(z.string().uuid()).default([]),
  })
  .strict()
  .refine((input) => input.endDate >= input.startDate, {
    message: 'endDate must be on or after startDate.',
    path: ['endDate'],
  });
export type CreateAppraisalCycleInput = z.infer<typeof createAppraisalCycleSchema>;

export const createGoalSchema = z
  .object({
    level: z.enum(GOAL_LEVELS),
    /** INDIVIDUAL only; omitted = the caller's own linked Employee (see GoalService.resolveOwnerEmployee). */
    employeeId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    parentGoalId: z.string().uuid().optional(),
    cycleId: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    targetValue: z.number().optional(),
    unit: z.string().max(20).optional(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .strict()
  .refine((input) => input.endDate >= input.startDate, {
    message: 'endDate must be on or after startDate.',
    path: ['endDate'],
  })
  .refine((input) => input.level !== 'TEAM' || Boolean(input.departmentId), {
    message: 'departmentId is required for a TEAM goal.',
    path: ['departmentId'],
  })
  .refine((input) => input.level !== 'COMPANY' || (!input.employeeId && !input.departmentId), {
    message: 'A COMPANY goal must not set employeeId or departmentId.',
    path: ['level'],
  });
export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalProgressSchema = z
  .object({
    currentValue: z.number().optional(),
    progressPercent: z.number().min(0).max(100).optional(),
    status: z.enum(GOAL_STATUSES).optional(),
  })
  .strict()
  .refine((input) => input.currentValue !== undefined || input.progressPercent !== undefined || input.status !== undefined, {
    message: 'At least one of currentValue, progressPercent, or status must be provided.',
  });
export type UpdateGoalProgressInput = z.infer<typeof updateGoalProgressSchema>;

export const assignPeerReviewersSchema = z
  .object({
    reviewerIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type AssignPeerReviewersInput = z.infer<typeof assignPeerReviewersSchema>;

export const submitReviewSchema = z
  .object({
    overallRating: z.number(),
    strengths: z.string().max(2000).optional(),
    improvements: z.string().max(2000).optional(),
    comments: z.string().max(2000).optional(),
  })
  .strict();
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
