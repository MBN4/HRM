import type { BenefitEnrollment, BenefitPlan, BenefitPlanTier, Employee, Prisma } from '@hrm/db';
import type { Expr, ExprVariable } from '@hrm/shared';
import { evaluateExpression } from '../country-packs/rules-engine/expression-evaluator';

/**
 * The benefits->payroll INPUT producer — see docs/conventions/benefits.md.
 * Pure, DI-free functions imported DIRECTLY by `PayrollRunProcessor`
 * (`apps/api/src/payroll/runs/payroll-run.processor.ts`'s additive
 * `mergeBenefitContributions` step), the SAME "consumer imports the reused
 * pure function across a module boundary" pattern `countBusinessDays`
 * (leave-day-calculator)/`computeStatutoryComponent`/`evaluateExpression`
 * already establish — never a NestJS DI import of `BenefitsModule` itself,
 * which would create a module-import cycle for no benefit. THE BOUNDARY:
 * this file never touches `netPay`/`employerCost` directly — it only
 * returns amounts; `PayrollRunProcessor` (the payroll ENGINE's own
 * orchestration, not the engine itself) decides how they're applied,
 * mirroring the Expenses reimbursement hand-off exactly (see
 * docs/conventions/operations-modules.md).
 *
 * Unlike `PayrollComponentDefinition` (computed BEFORE gross pay exists),
 * a benefit contribution is computed AFTER — `PayrollRunProcessor` calls
 * this once the engine/DELEGATE adapter has already returned
 * `grossPay`/`netPay`/`employerCost` for the period — so `variables` here
 * carries the FULL `grossSalary`/`monthlySalary`/`annualSalary`/
 * `basicSalary`/`yearsOfService` set, exactly like a CountryPack
 * `statutory.component` can reference.
 */

export interface BenefitContributionResult {
  enrollmentId: string;
  planId: string;
  planName: string;
  employeeAmount: number;
  employerAmount: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A `hasTiers` plan prices EACH tier with its own explicit flat
 * employee/employer amount, bypassing `employeeSharePercent`/
 * `employerSharePercent` entirely (a tier already states both sides — see
 * the `BenefitPlanTier` schema doc comment). Otherwise, the plan's
 * `costBasis` computes ONE total cost (mirroring
 * `PayrollComponentDefinition`'s own `FIXED_AMOUNT`/`PERCENTAGE_OF_BASE`/
 * `FORMULA` field-for-field, `FORMULA` reusing 0.5's `evaluateExpression`
 * AS-IS), which the share percentages then split.
 */
export function computeBenefitContributionAmount(
  plan: Pick<BenefitPlan, 'costBasis' | 'fixedAmount' | 'percentageOfBase' | 'percentageRate' | 'formula' | 'hasTiers' | 'employeeSharePercent' | 'employerSharePercent'>,
  tier: Pick<BenefitPlanTier, 'employeeAmount' | 'employerAmount'> | null,
  variables: Readonly<Partial<Record<ExprVariable, number>>>,
): { employeeAmount: number; employerAmount: number } {
  if (plan.hasTiers) {
    if (!tier) {
      return { employeeAmount: 0, employerAmount: 0 };
    }
    return { employeeAmount: round2(Number(tier.employeeAmount)), employerAmount: round2(Number(tier.employerAmount)) };
  }

  let totalCost: number;
  switch (plan.costBasis) {
    case 'FIXED_AMOUNT':
      totalCost = Number(plan.fixedAmount ?? 0);
      break;
    case 'PERCENTAGE_OF_BASE': {
      const base = plan.percentageOfBase ? (variables[plan.percentageOfBase as ExprVariable] ?? 0) : 0;
      totalCost = base * (plan.percentageRate ?? 0);
      break;
    }
    case 'FORMULA':
      totalCost = evaluateExpression(plan.formula as Expr, variables);
      break;
    default:
      totalCost = 0;
  }
  return { employeeAmount: round2(totalCost * plan.employeeSharePercent), employerAmount: round2(totalCost * plan.employerSharePercent) };
}

/**
 * Every enrollment ACTIVE for at least part of `[periodStart, periodEnd]`
 * on a plan that both `isActive` and `affectsPayroll` — a purely
 * informational plan (`affectsPayroll: false`, e.g. an office perk) never
 * reaches this list at all, so it can never accidentally become a payroll
 * input.
 */
export async function resolveActiveBenefitContributions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employee: Employee,
  periodStart: Date,
  periodEnd: Date,
  variables: Readonly<Partial<Record<ExprVariable, number>>>,
): Promise<{ enrollment: BenefitEnrollment; contribution: BenefitContributionResult }[]> {
  const enrollments = await tx.benefitEnrollment.findMany({
    where: {
      tenantId,
      employeeId: employee.id,
      status: 'ACTIVE',
      effectiveFrom: { lte: periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }],
    },
    include: { plan: true, coverageTier: true },
  });

  return enrollments
    .filter((enrollment) => enrollment.plan.isActive && enrollment.plan.affectsPayroll)
    .map((enrollment) => ({
      enrollment,
      contribution: {
        enrollmentId: enrollment.id,
        planId: enrollment.planId,
        planName: enrollment.plan.name,
        ...computeBenefitContributionAmount(enrollment.plan, enrollment.coverageTier, variables),
      },
    }));
}
