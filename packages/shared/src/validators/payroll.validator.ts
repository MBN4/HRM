import { z } from 'zod';
import { exprSchema } from './rules-engine.validator';

/**
 * The Payroll module's schema — see docs/conventions/payroll.md. Salary
 * STRUCTURE (earnings/allowances/discretionary deductions) is a
 * payroll-owned concept, deliberately NOT added to 0.5's
 * `countryPackConfigSchema` (that file is off-limits to this step — see
 * payroll.md's scope-discipline note): `tax.layers`/`statutory.components`
 * remain the ONLY source of mandatory tax/statutory deductions, computed
 * by the EXISTING, unmodified `computeMultiLayerTax`/
 * `computeStatutoryComponents` (apps/api/src/country-packs/rules-engine).
 * `formula` here reuses 0.5's `exprSchema` AS-IS — imported, not
 * redefined, the SAME "reuse the whitelist itself, not just the approach"
 * posture 0.7's workflow condition evaluator already documents for its own
 * AST (see docs/conventions/workflow.md).
 */

export const PAYROLL_COMPONENT_TYPES = ['EARNING', 'ALLOWANCE', 'DEDUCTION'] as const;
export type PayrollComponentType = (typeof PAYROLL_COMPONENT_TYPES)[number];

const componentBaseFields = {
  countryCode: z.string().length(2),
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  type: z.enum(PAYROLL_COMPONENT_TYPES),
  order: z.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
};

/**
 * `FORMULA` components may reference ONLY `basicSalary`/`yearsOfService` —
 * NOT `grossSalary`/`monthlySalary`/`annualSalary`, which the engine only
 * knows AFTER every component has been summed (see payroll.md's
 * evaluation-order note). This is enforced by `PayrollEngineService`, not
 * by this schema — `exprSchema` itself stays exactly as 0.5 defined it, no
 * narrower variant is created here (still no "second evaluator").
 */
export const createPayrollComponentSchema = z.discriminatedUnion('calcKind', [
  z.object({ ...componentBaseFields, calcKind: z.literal('FIXED_AMOUNT'), fixedAmount: z.number().nonnegative() }).strict(),
  z
    .object({
      ...componentBaseFields,
      calcKind: z.literal('PERCENTAGE_OF_BASE'),
      // Deliberately narrower than 0.5's full `SALARY_BASES` — a component
      // is computed BEFORE gross pay exists at all (it's an input to
      // gross, not derived from it), so `grossSalary`/`monthlySalary`/
      // `annualSalary` are not yet meaningful here. Only the employee's
      // contractual basic salary is known this early. See
      // docs/conventions/payroll.md's evaluation-order note.
      percentageOfBase: z.literal('basicSalary'),
      percentageRate: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ ...componentBaseFields, calcKind: z.literal('FORMULA'), formula: exprSchema }).strict(),
]);
export type CreatePayrollComponentInput = z.infer<typeof createPayrollComponentSchema>;

export const runPayrollSchema = z
  .object({
    branchId: z.string().uuid(),
    periodYear: z.number().int().min(2000).max(2100),
    periodMonth: z.number().int().min(1).max(12),
  })
  .strict();
export type RunPayrollInput = z.infer<typeof runPayrollSchema>;
