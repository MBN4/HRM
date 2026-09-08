import { z } from 'zod';
import { exprSchema, SALARY_BASES } from './rules-engine.validator';

/**
 * Benefits Administration (step 3.5.2) — see
 * docs/conventions/benefits.md. THE BOUNDARY (same shape as Payroll's own,
 * 2.1): this module never computes pay — a plan's cost structure and a
 * statutory scheme both only ever produce PAYROLL INPUTS, merged onto a
 * real payroll run the same way Expenses' reimbursement hand-off is (see
 * docs/conventions/operations-modules.md). `formula` reuses 0.5's
 * `exprSchema` AS-IS — imported, not redefined, the same "reuse the
 * whitelist itself" posture every other formula-bearing schema in this
 * codebase already takes (Payroll's own salary-structure components,
 * 0.7's workflow condition evaluator).
 *
 * Unlike `PayrollComponentDefinition` (computed BEFORE gross pay exists,
 * so narrowed to `basicSalary`/`yearsOfService` only — see
 * payroll.validator.ts), a benefit contribution is computed AFTER gross
 * pay already exists (`PayrollRunProcessor`'s additive
 * `mergeBenefitContributions` step runs once the engine/adapter has
 * already returned `grossPay`/`netPay`/`employerCost` — see
 * apps/api/src/benefits/benefits-payroll-input.util.ts), so `percentageOfBase`/
 * `formula` may reference the FULL `SALARY_BASES`/`ALLOWED_EXPR_VARIABLES`
 * set, exactly like a CountryPack `statutory.component` can.
 */

export const BENEFIT_TYPES = [
  'HEALTH_INSURANCE',
  'PROVIDENT_FUND',
  'PENSION',
  'LIFE_INSURANCE',
  'BONUS_INCENTIVE',
  'ALLOWANCE',
  'OTHER',
] as const;
export type BenefitType = (typeof BENEFIT_TYPES)[number];

export const BENEFIT_COST_BASES = ['FIXED_AMOUNT', 'PERCENTAGE_OF_BASE', 'FORMULA'] as const;
export type BenefitCostBasis = (typeof BENEFIT_COST_BASES)[number];

export const BENEFIT_ENROLLMENT_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'CANCELLED', 'EXPIRED'] as const;
export type BenefitEnrollmentStatus = (typeof BENEFIT_ENROLLMENT_STATUSES)[number];

export const benefitPlanTierInputSchema = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    employeeAmount: z.number().nonnegative().default(0),
    employerAmount: z.number().nonnegative().default(0),
    order: z.number().int().nonnegative().default(0),
  })
  .strict();
export type BenefitPlanTierInput = z.infer<typeof benefitPlanTierInputSchema>;

const planBaseFields = {
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  benefitType: z.enum(BENEFIT_TYPES),
  description: z.string().max(2000).optional(),
  currencyCode: z.string().length(3),
  // Fractions of the plan's total computed cost — see the schema doc
  // comment above for why a single cost structure + one split is used
  // rather than two independently-configured amounts. Validated to sum to
  // 1.0 (within floating-point tolerance) by `.refine()` below.
  employeeSharePercent: z.number().min(0).max(1).default(0),
  employerSharePercent: z.number().min(0).max(1).default(1),
  hasTiers: z.boolean().default(false),
  tiers: z.array(benefitPlanTierInputSchema).default([]),
  allowSelfElection: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  affectsPayroll: z.boolean().default(true),
  isActive: z.boolean().default(true),
};

export const createBenefitPlanSchema = z
  .discriminatedUnion('costBasis', [
    z.object({ ...planBaseFields, costBasis: z.literal('FIXED_AMOUNT'), fixedAmount: z.number().nonnegative() }).strict(),
    z
      .object({
        ...planBaseFields,
        costBasis: z.literal('PERCENTAGE_OF_BASE'),
        percentageOfBase: z.enum(SALARY_BASES),
        percentageRate: z.number().min(0).max(1),
      })
      .strict(),
    z.object({ ...planBaseFields, costBasis: z.literal('FORMULA'), formula: exprSchema }).strict(),
  ])
  .refine((input) => Math.abs(input.employeeSharePercent + input.employerSharePercent - 1) < 1e-9, {
    message: 'employeeSharePercent and employerSharePercent must sum to 1.0.',
  })
  .refine((input) => !input.hasTiers || input.tiers.length > 0, {
    message: 'A plan with hasTiers=true needs at least one coverage tier.',
  });
export type CreateBenefitPlanInput = z.infer<typeof createBenefitPlanSchema>;

export const createBenefitEnrollmentSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    planId: z.string().uuid(),
    coverageTierId: z.string().uuid().optional(),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().optional(),
    dependentIds: z.array(z.string().uuid()).default([]),
  })
  .strict();
export type CreateBenefitEnrollmentInput = z.infer<typeof createBenefitEnrollmentSchema>;
