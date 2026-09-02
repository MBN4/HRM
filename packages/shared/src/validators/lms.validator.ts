import { z } from 'zod';

/**
 * Learning & Development (LMS, step 3.2) — see docs/conventions/lms.md.
 * Quizzes and required-training rules are tenant-authored DATA (courses/
 * questions/pass marks/eligibility), never hardcoded scoring or
 * eligibility logic — the SAME "config as data" posture Country Packs/
 * workflow approver rules/custom fields already take throughout this
 * codebase.
 */
export const CONTENT_ITEM_TYPES = ['VIDEO', 'DOCUMENT', 'LINK'] as const;
export type ContentItemTypeKey = (typeof CONTENT_ITEM_TYPES)[number];

export const createCourseCategorySchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();
export type CreateCourseCategoryInput = z.infer<typeof createCourseCategorySchema>;

export const createCourseSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    isMandatory: z.boolean().optional(),
    validityMonths: z.number().int().positive().optional(),
  })
  .strict();
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = createCourseSchema.partial();
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

export const createContentItemSchema = z
  .object({
    moduleName: z.string().max(200).optional(),
    orderIndex: z.number().int().nonnegative(),
    type: z.enum(CONTENT_ITEM_TYPES),
    title: z.string().min(1).max(200),
    externalUrl: z.string().url().max(2000).optional(),
    durationMinutes: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => (value.type === 'LINK' ? !!value.externalUrl : true), {
    message: 'A LINK content item requires externalUrl.',
    path: ['externalUrl'],
  });
export type CreateContentItemInput = z.infer<typeof createContentItemSchema>;

export const assignEnrollmentSchema = z
  .object({
    employeeId: z.string().uuid(),
    dueDate: z.coerce.date().optional(),
  })
  .strict();
export type AssignEnrollmentInput = z.infer<typeof assignEnrollmentSchema>;

export const quizOptionSchema = z
  .object({
    key: z.string().min(1).max(20),
    text: z.string().min(1).max(500),
  })
  .strict();

export const upsertQuizSchema = z
  .object({
    title: z.string().min(1).max(200),
    passMarkPercent: z.number().int().min(1).max(100).optional(),
    isRequired: z.boolean().optional(),
  })
  .strict();
export type UpsertQuizInput = z.infer<typeof upsertQuizSchema>;

export const createQuizQuestionSchema = z
  .object({
    orderIndex: z.number().int().nonnegative(),
    questionText: z.string().min(1).max(1000),
    options: z.array(quizOptionSchema).min(2).max(10),
    correctOptionKey: z.string().min(1).max(20),
    points: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.options.some((option) => option.key === value.correctOptionKey), {
    message: 'correctOptionKey must match one of the supplied options.',
    path: ['correctOptionKey'],
  });
export type CreateQuizQuestionInput = z.infer<typeof createQuizQuestionSchema>;

export const submitQuizAttemptSchema = z
  .object({
    answers: z.record(z.string().uuid(), z.string().min(1).max(20)),
  })
  .strict();
export type SubmitQuizAttemptInput = z.infer<typeof submitQuizAttemptSchema>;

export const runLmsRollupSchema = z
  .object({
    /** Defaults to "yesterday" (UTC), same as the real scheduled orchestrator's own default. */
    date: z.coerce.date().optional(),
  })
  .strict();
export type RunLmsRollupInput = z.infer<typeof runLmsRollupSchema>;

export const upsertRequiredTrainingSchema = z
  .object({
    courseId: z.string().uuid(),
    roleId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
  })
  .strict();
export type UpsertRequiredTrainingInput = z.infer<typeof upsertRequiredTrainingSchema>;
