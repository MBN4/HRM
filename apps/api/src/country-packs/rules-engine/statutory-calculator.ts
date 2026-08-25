import { ExprVariable, StatutoryComponent, StatutoryTier } from '@hrm/shared';
import { evaluateExpression } from './expression-evaluator';

export interface StatutoryComponentResult {
  name: string;
  appliesTo: StatutoryComponent['appliesTo'];
  amount: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Weeks-of-base-salary-per-year-of-service, tiered — e.g. Qatar's end-of-service gratuity (3 weeks/year for the first 5 years, 4 weeks/year after). */
function computeTieredByYearsOfService(tiers: StatutoryTier[], monthlyBase: number, yearsOfService: number): number {
  const dailyWage = monthlyBase / 30;
  let total = 0;
  let previousUpTo = 0;
  for (const tier of tiers) {
    const upToYears = tier.upToYears ?? Infinity;
    const yearsInTier = Math.max(0, Math.min(yearsOfService, upToYears) - previousUpTo);
    total += yearsInTier * tier.weeksPerYear * 7 * dailyWage;
    previousUpTo = upToYears;
    if (yearsOfService <= upToYears) {
      break;
    }
  }
  return total;
}

/**
 * Computes one statutory contribution component (social security, pension,
 * end-of-service gratuity, unemployment insurance, ...) from pack DATA,
 * never a code branch on which country or component this is. `PERCENTAGE`
 * and `TIERED_BY_YEARS_OF_SERVICE` are fixed, generic algorithms
 * parameterized by the component's data; `FORMULA` delegates to the
 * sandboxed expression evaluator for anything those two shapes can't
 * express.
 */
export function computeStatutoryComponent(
  component: StatutoryComponent,
  variables: Readonly<Partial<Record<ExprVariable, number>>> & { yearsOfService?: number },
): StatutoryComponentResult {
  let amount: number;
  switch (component.kind) {
    case 'PERCENTAGE': {
      const base = variables[component.base] ?? 0;
      const taxable = component.cap !== undefined ? Math.min(base, component.cap) : base;
      amount = taxable * component.rate;
      break;
    }
    case 'TIERED_BY_YEARS_OF_SERVICE': {
      const base = variables[component.base] ?? 0;
      const years = variables.yearsOfService ?? 0;
      amount = computeTieredByYearsOfService(component.tiers, base, years);
      break;
    }
    case 'FORMULA':
      amount = evaluateExpression(component.formula, variables);
      break;
  }
  return { name: component.name, appliesTo: component.appliesTo, amount: round2(amount) };
}

export function computeStatutoryComponents(
  components: StatutoryComponent[],
  variables: Readonly<Partial<Record<ExprVariable, number>>> & { yearsOfService?: number },
): StatutoryComponentResult[] {
  return components.map((component) => computeStatutoryComponent(component, variables));
}
