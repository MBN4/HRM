import { z } from 'zod';

/**
 * SECURITY BOUNDARY — read this before touching anything in this file.
 *
 * `Expr` is the ONLY shape a CountryPack's tax/statutory "formula" fields
 * may take. It is a fixed, whitelisted AST — never a string to be parsed or
 * `eval`'d. There is no operator, variable, or node type here beyond what
 * is enumerated below; `apps/api`'s expression evaluator (the actual rules
 * engine — see `apps/api/src/country-packs/rules-engine/expression-evaluator.ts`)
 * interprets ONLY these node shapes and throws on anything else. Together,
 * this schema (validated on every write AND every read of pack/override
 * JSON) and that evaluator are the two halves of the sandbox: malformed or
 * out-of-whitelist data can never reach evaluation, and even if it did, the
 * evaluator itself refuses it. Extending the whitelist (a new operator, a
 * new variable) is a deliberate, reviewed code change here — never a
 * runtime configuration option.
 */
export const ALLOWED_EXPR_VARIABLES = [
  'grossSalary',
  'monthlySalary',
  'annualSalary',
  'basicSalary',
  'yearsOfService',
] as const;
export type ExprVariable = (typeof ALLOWED_EXPR_VARIABLES)[number];

export const ALLOWED_EXPR_OPERATORS = ['+', '-', '*', '/', 'min', 'max'] as const;
export type ExprOperator = (typeof ALLOWED_EXPR_OPERATORS)[number];

export type Expr =
  | { type: 'const'; value: number }
  | { type: 'var'; name: ExprVariable }
  | { type: 'binary'; op: ExprOperator; left: Expr; right: Expr }
  | { type: 'clamp'; value: Expr; min?: Expr; max?: Expr };

/**
 * Recursive zod schema mirroring `Expr` exactly. `z.lazy` is required for
 * the self-reference; the union is otherwise a plain, closed shape — any
 * JSON that doesn't match one of these four node shapes fails validation.
 */
export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('const'), value: z.number() }),
    z.object({ type: z.literal('var'), name: z.enum(ALLOWED_EXPR_VARIABLES) }),
    z.object({
      type: z.literal('binary'),
      op: z.enum(ALLOWED_EXPR_OPERATORS),
      left: exprSchema,
      right: exprSchema,
    }),
    z.object({
      type: z.literal('clamp'),
      value: exprSchema,
      min: exprSchema.optional(),
      max: exprSchema.optional(),
    }),
  ]),
);

export const SALARY_BASES = ['grossSalary', 'annualSalary', 'monthlySalary', 'basicSalary'] as const;
export type SalaryBase = (typeof SALARY_BASES)[number];

export const taxBracketSchema = z.object({
  /** Upper bound of this bracket, in the layer's `base` unit. `null` = no upper bound (top bracket). */
  upTo: z.number().positive().nullable(),
  /** Fraction, e.g. 0.22 for 22%. */
  rate: z.number().min(0).max(1),
});
export type TaxBracket = z.infer<typeof taxBracketSchema>;

export const taxLayerSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string().min(1),
    kind: z.literal('PROGRESSIVE_BRACKETS'),
    base: z.enum(SALARY_BASES),
    brackets: z.array(taxBracketSchema).min(1),
  }),
  z.object({
    name: z.string().min(1),
    kind: z.literal('FLAT_RATE'),
    base: z.enum(SALARY_BASES),
    rate: z.number().min(0).max(1),
    /** Wage-base cap, e.g. the US Social Security wage base — amounts above this are not taxed by this layer. */
    cap: z.number().positive().optional(),
  }),
  z.object({
    name: z.string().min(1),
    kind: z.literal('FORMULA'),
    formula: exprSchema,
  }),
]);
export type TaxLayer = z.infer<typeof taxLayerSchema>;

export const statutoryTierSchema = z.object({
  /** Upper bound of this tier, in years of service. `null` = no upper bound (final tier). */
  upToYears: z.number().positive().nullable(),
  weeksPerYear: z.number().positive(),
});
export type StatutoryTier = z.infer<typeof statutoryTierSchema>;

export const statutoryComponentSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string().min(1),
    appliesTo: z.enum(['EMPLOYEE', 'EMPLOYER', 'BOTH']),
    kind: z.literal('PERCENTAGE'),
    base: z.enum(SALARY_BASES),
    rate: z.number().min(0).max(1),
    cap: z.number().positive().optional(),
  }),
  z.object({
    name: z.string().min(1),
    appliesTo: z.enum(['EMPLOYEE', 'EMPLOYER', 'BOTH']),
    kind: z.literal('TIERED_BY_YEARS_OF_SERVICE'),
    base: z.enum(SALARY_BASES),
    tiers: z.array(statutoryTierSchema).min(1),
  }),
  z.object({
    name: z.string().min(1),
    appliesTo: z.enum(['EMPLOYEE', 'EMPLOYER', 'BOTH']),
    kind: z.literal('FORMULA'),
    formula: exprSchema,
  }),
]);
export type StatutoryComponent = z.infer<typeof statutoryComponentSchema>;
