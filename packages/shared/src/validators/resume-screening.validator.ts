import { z } from 'zod';

/**
 * Resume parsing + candidate screening schemas (step 9.1) — see
 * docs/conventions/resume-parsing-screening.md. `parsedResumeSchema` is the
 * ONE shape every `RESUME_PARSER` adapter must produce AND the shape a
 * recruiter's manual edit is validated against, so a swapped-in parser can
 * never write something the editor/scorer can't read.
 */

/** Ordered lowest → highest; `educationRank` is the comparison the scorer uses. */
export const EDUCATION_LEVELS = ['NONE', 'HIGH_SCHOOL', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export function educationRank(level: EducationLevel | null | undefined): number {
  return level ? EDUCATION_LEVELS.indexOf(level) : 0;
}

export const RESUME_PARSE_STATUSES = ['NONE', 'PENDING', 'PARSED', 'FAILED'] as const;
export type ResumeParseStatusKey = (typeof RESUME_PARSE_STATUSES)[number];

const shortText = z.string().trim().max(300);

export const parsedExperienceSchema = z
  .object({
    title: shortText.nullish(),
    company: shortText.nullish(),
    /** Free-form-but-normalised by the default parser to `YYYY` or `YYYY-MM`. */
    startDate: z.string().trim().max(20).nullish(),
    /** `YYYY`, `YYYY-MM`, or the literal `present`. */
    endDate: z.string().trim().max(20).nullish(),
    description: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type ParsedExperience = z.infer<typeof parsedExperienceSchema>;

export const parsedEducationSchema = z
  .object({
    degree: shortText.nullish(),
    field: shortText.nullish(),
    institution: shortText.nullish(),
    level: z.enum(EDUCATION_LEVELS).nullish(),
    endYear: z.number().int().min(1900).max(2100).nullish(),
  })
  .strict();
export type ParsedEducation = z.infer<typeof parsedEducationSchema>;

export const parsedResumeSchema = z
  .object({
    fullName: shortText.nullish(),
    email: z.string().trim().max(320).nullish(),
    phone: z.string().trim().max(50).nullish(),
    skills: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
    experience: z.array(parsedExperienceSchema).max(50).default([]),
    education: z.array(parsedEducationSchema).max(20).default([]),
    totalYearsExperience: z.number().min(0).max(70).nullish(),
    links: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    summary: z.string().trim().max(3000).nullish(),
    /** Extracted plain text (truncated) — what keyword must-haves match against. Never shown in the editor. */
    rawText: z.string().max(30000).nullish(),
  })
  .strict();
export type ParsedResume = z.infer<typeof parsedResumeSchema>;

/** A recruiter's edit — `rawText` is server-owned and preserved, so it is not accepted here. */
export const updateParsedResumeSchema = parsedResumeSchema.omit({ rawText: true }).strict();
export type UpdateParsedResumeInput = z.infer<typeof updateParsedResumeSchema>;

// --- Screening criteria ------------------------------------------------------

export const SCREENING_CRITERION_KEYS = ['requiredSkills', 'preferredSkills', 'experience', 'education', 'keywords'] as const;
export type ScreeningCriterionKey = (typeof SCREENING_CRITERION_KEYS)[number];

const skillList = z.array(z.string().trim().min(1).max(80)).max(50).default([]);

export const screeningWeightsSchema = z
  .object({
    requiredSkills: z.number().int().min(0).max(100).default(40),
    preferredSkills: z.number().int().min(0).max(100).default(15),
    experience: z.number().int().min(0).max(100).default(20),
    education: z.number().int().min(0).max(100).default(10),
    keywords: z.number().int().min(0).max(100).default(15),
  })
  .strict();
export type ScreeningWeights = z.infer<typeof screeningWeightsSchema>;

export const screeningCriteriaConfigSchema = z
  .object({
    requiredSkills: skillList,
    preferredSkills: skillList,
    minYearsExperience: z.number().min(0).max(70).nullish(),
    minEducation: z.enum(EDUCATION_LEVELS).nullish(),
    keywordMustHaves: skillList,
    weights: screeningWeightsSchema.default({}),
    /** An applicant scoring below this is FLAGGED for a human — never auto-rejected. */
    belowThresholdScore: z.number().int().min(0).max(100).default(40),
  })
  .strict();
export type ScreeningCriteriaConfig = z.infer<typeof screeningCriteriaConfigSchema>;
export type ScreeningCriteriaConfigInput = z.input<typeof screeningCriteriaConfigSchema>;

export const upsertScreeningCriteriaSchema = screeningCriteriaConfigSchema;
export type UpsertScreeningCriteriaInput = ScreeningCriteriaConfigInput;

// --- Screening result (computed; read-only over the API) ---------------------

export const SCREENING_CRITERION_STATUSES = ['MET', 'PARTIAL', 'MISSED'] as const;
export type ScreeningCriterionStatus = (typeof SCREENING_CRITERION_STATUSES)[number];

export interface ScreeningCriterionResult {
  key: ScreeningCriterionKey;
  status: ScreeningCriterionStatus;
  /** Effective weight after normalising across the criteria actually configured (sums to 100). */
  maxPoints: number;
  earnedPoints: number;
  matched: string[];
  missed: string[];
  /** Human-readable one-liner, e.g. "4.5 yrs vs 5 required". Server-generated, English; the UI shows structured fields in the viewer's language. */
  detail: string;
  /** Raw numbers for the UI to localise ("actual"/"required"), where applicable. */
  actual?: number | string | null;
  required?: number | string | null;
}

export interface ScreeningResult {
  score: number;
  belowThreshold: boolean;
  threshold: number;
  criteria: ScreeningCriterionResult[];
  /** Whether the parsed data the score was computed from had been hand-edited by a recruiter. */
  basedOnEditedData: boolean;
  computedAt: string;
}

export const rankedApplicationsQuerySchema = z
  .object({
    jobPostingId: z.string().uuid().optional(),
    requisitionId: z.string().uuid().optional(),
    stage: z.string().optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    minYears: z.coerce.number().min(0).max(70).optional(),
    skill: z.string().trim().min(1).max(80).optional(),
    belowThreshold: z.enum(['true', 'false']).optional(),
    sort: z.enum(['score', 'experience', 'appliedAt']).default('score'),
  })
  .strict();
export type RankedApplicationsQuery = z.infer<typeof rankedApplicationsQuerySchema>;
