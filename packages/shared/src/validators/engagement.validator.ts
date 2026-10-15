import { z } from 'zod';

/**
 * Engagement & culture (step 10.1) — recognition, surveys, the social feed. See
 * docs/conventions/engagement-culture.md. Limits are deliberately modest: this is a
 * kudos/survey/feed feature, not a document store.
 */

export const MAX_RECOGNITION_RECIPIENTS = 10;
export const MAX_SURVEY_QUESTIONS = 50;
export const MAX_RATING_SCALE = 10;
/** An anonymous survey's per-question results are withheld until this many responses exist (see SurveyResultsService). */
export const ANONYMITY_MIN_RESPONSES = 3;

// ---- Recognition ----------------------------------------------------------

export const upsertRecognitionCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    points: z.number().int().min(0).max(100).default(1),
    isActive: z.boolean().default(true),
  })
  .strict();
export type UpsertRecognitionCategoryInput = z.infer<typeof upsertRecognitionCategorySchema>;

export const giveRecognitionSchema = z
  .object({
    recipientEmployeeIds: z.array(z.string().uuid()).min(1).max(MAX_RECOGNITION_RECIPIENTS),
    categoryId: z.string().uuid(),
    message: z.string().trim().min(1).max(1000),
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  })
  .strict();
export type GiveRecognitionInput = z.infer<typeof giveRecognitionSchema>;

export const leaderboardQuerySchema = z.object({
  /** Period start (inclusive), ISO date. Defaults to 30 days ago. */
  from: z.string().date().optional(),
  /** Period end (inclusive), ISO date. Defaults to today. */
  to: z.string().date().optional(),
  categoryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

// ---- Surveys --------------------------------------------------------------

const surveyOptionSchema = z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200) }).strict();

export const surveyQuestionInputSchema = z
  .object({
    type: z.enum(['RATING', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT']),
    prompt: z.string().trim().min(1).max(500),
    required: z.boolean().default(true),
    scaleMin: z.number().int().min(0).max(1).optional(),
    scaleMax: z.number().int().min(2).max(MAX_RATING_SCALE).optional(),
    options: z.array(surveyOptionSchema).min(2).max(20).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.type === 'RATING') {
      if (q.scaleMax === undefined) {
        ctx.addIssue({ code: 'custom', path: ['scaleMax'], message: 'A rating question needs a scaleMax.' });
      }
      if (q.options) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'A rating question has no options.' });
      }
    } else if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
      if (!q.options) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'A choice question needs options.' });
      } else if (new Set(q.options.map((o) => o.id)).size !== q.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option ids must be unique within a question.' });
      }
    } else if (q.options || q.scaleMax !== undefined || q.scaleMin !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'A free-text question takes no scale or options.' });
    }
  });
export type SurveyQuestionInput = z.infer<typeof surveyQuestionInputSchema>;

const surveyBase = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  anonymous: z.boolean().default(false),
  audienceType: z.enum(['ORG', 'BRANCH', 'DEPARTMENT', 'TEAM']).default('ORG'),
  /** BRANCH -> branch ids; DEPARTMENT -> department ids; TEAM -> manager EMPLOYEE ids (their reporting chain). Empty for ORG. */
  audienceIds: z.array(z.string().uuid()).max(100).default([]),
  opensAt: z.string().datetime().optional(),
  closesAt: z.string().datetime().optional(),
  questions: z.array(surveyQuestionInputSchema).min(1).max(MAX_SURVEY_QUESTIONS),
});

function refineSurvey(s: { audienceType?: string; audienceIds?: string[]; opensAt?: string; closesAt?: string }, ctx: z.RefinementCtx) {
  if (s.audienceType === 'ORG' && s.audienceIds && s.audienceIds.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['audienceIds'], message: 'An org-wide survey takes no audienceIds.' });
  }
  if (s.audienceType && s.audienceType !== 'ORG' && (!s.audienceIds || s.audienceIds.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['audienceIds'], message: `A ${s.audienceType} survey needs at least one audience id.` });
  }
  if (s.opensAt && s.closesAt && new Date(s.closesAt) <= new Date(s.opensAt)) {
    ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'closesAt must be after opensAt.' });
  }
}

export const createSurveySchema = surveyBase.strict().superRefine(refineSurvey);
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;

/** A DRAFT survey is edited by full replacement (same "PUT replaces the whole resource" contract as the rest of the codebase). */
export const updateSurveySchema = createSurveySchema;
export type UpdateSurveyInput = CreateSurveyInput;

const answerSchema = z
  .object({
    questionId: z.string().uuid(),
    ratingValue: z.number().int().optional(),
    optionIds: z.array(z.string().max(40)).max(20).optional(),
    text: z.string().max(4000).optional(),
  })
  .strict();

export const submitSurveyResponseSchema = z.object({ answers: z.array(answerSchema).max(MAX_SURVEY_QUESTIONS) }).strict();
export type SubmitSurveyResponseInput = z.infer<typeof submitSurveyResponseSchema>;

// ---- Feed -----------------------------------------------------------------

export const createFeedPostSchema = z
  .object({
    type: z.enum(['ANNOUNCEMENT', 'CELEBRATION']).default('ANNOUNCEMENT'),
    title: z.string().trim().max(200).optional(),
    body: z.string().trim().min(1).max(5000),
    scopeType: z.enum(['ORG', 'BRANCH', 'DEPARTMENT']).default('ORG'),
    scopeId: z.string().uuid().optional(),
    pinned: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.scopeType === 'ORG' && p.scopeId) {
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'An org-wide post takes no scopeId.' });
    }
    if (p.scopeType !== 'ORG' && !p.scopeId) {
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: `A ${p.scopeType} post needs a scopeId.` });
    }
  });
export type CreateFeedPostInput = z.infer<typeof createFeedPostSchema>;

export const feedQuerySchema = z.object({
  /** `ALL` = everything visible to me; `ORG` = company-wide only; `TEAM` = posts targeting my branch/department. */
  scope: z.enum(['ALL', 'ORG', 'TEAM']).default('ALL'),
  /** Opaque cursor: ISO `createdAt` of the last post of the previous page. */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

export const reactSchema = z.object({ type: z.enum(['LIKE', 'CELEBRATE']) }).strict();
export type ReactInput = z.infer<typeof reactSchema>;

export const createFeedCommentSchema = z.object({ body: z.string().trim().min(1).max(1000) }).strict();
export type CreateFeedCommentInput = z.infer<typeof createFeedCommentSchema>;

export const moderationSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();
export type ModerationInput = z.infer<typeof moderationSchema>;

export const overviewQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;
