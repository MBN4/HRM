import { StatutoryComponent } from '@hrm/shared';
import { QATAR_PACK, USA_PACK } from '@hrm/db';
import { computeStatutoryComponent, computeStatutoryComponents } from './statutory-calculator';

describe('computeStatutoryComponent', () => {
  it('computes a flat PERCENTAGE component with a cap (e.g. US FUTA)', () => {
    const component: StatutoryComponent = {
      name: 'test_percentage',
      appliesTo: 'EMPLOYER',
      kind: 'PERCENTAGE',
      base: 'annualSalary',
      rate: 0.006,
      cap: 7_000,
    };
    expect(computeStatutoryComponent(component, { annualSalary: 50_000 }).amount).toBeCloseTo(7_000 * 0.006);
    expect(computeStatutoryComponent(component, { annualSalary: 3_000 }).amount).toBeCloseTo(3_000 * 0.006);
  });

  it('computes a real Qatar end-of-service gratuity example from pack data (3 weeks/year for the first 5 years, 4 weeks/year after)', () => {
    const [gratuity] = QATAR_PACK.statutory.components;
    expect(gratuity.kind).toBe('TIERED_BY_YEARS_OF_SERVICE');

    // basicSalary 6,000 QAR/month, 7 years of service:
    // first 5 years: 5 * 3 weeks = 15 weeks = 105 days @ (6000/30 = 200/day) = 21,000
    // next 2 years:  2 * 4 weeks =  8 weeks =  56 days @ 200/day           = 11,200
    // total = 32,200
    const result = computeStatutoryComponent(gratuity, { basicSalary: 6_000, yearsOfService: 7 });
    expect(result.amount).toBeCloseTo(32_200);
    expect(result.appliesTo).toBe('EMPLOYER');
  });

  it('a tenured employee under 5 years only accrues the first tier', () => {
    const [gratuity] = QATAR_PACK.statutory.components;
    // 3 years @ 3 weeks = 9 weeks = 63 days @ 200/day = 12,600
    const result = computeStatutoryComponent(gratuity, { basicSalary: 6_000, yearsOfService: 3 });
    expect(result.amount).toBeCloseTo(12_600);
  });

  it('computes a FORMULA component via the sandboxed expression evaluator', () => {
    const component: StatutoryComponent = {
      name: 'test_formula',
      appliesTo: 'BOTH',
      kind: 'FORMULA',
      formula: {
        type: 'clamp',
        value: { type: 'binary', op: '*', left: { type: 'var', name: 'monthlySalary' }, right: { type: 'const', value: 0.05 } },
        max: { type: 'const', value: 300 },
      },
    };
    expect(computeStatutoryComponent(component, { monthlySalary: 10_000 }).amount).toBe(300);
    expect(computeStatutoryComponent(component, { monthlySalary: 1_000 }).amount).toBe(50);
  });
});

describe('cross-country divergence proof: the SAME computeStatutoryComponents function, different data', () => {
  it('the US pack has no end-of-service-style component; Qatar has no percentage-of-salary withholding component', () => {
    expect(USA_PACK.statutory.components.some((c) => c.kind === 'TIERED_BY_YEARS_OF_SERVICE')).toBe(false);
    expect(QATAR_PACK.statutory.components.some((c) => c.kind === 'PERCENTAGE')).toBe(false);
  });

  it('computes both countries\' full statutory component sets without any country-code branch in the calculator itself', () => {
    const usResults = computeStatutoryComponents(USA_PACK.statutory.components, { annualSalary: 60_000 });
    const qaResults = computeStatutoryComponents(QATAR_PACK.statutory.components, { basicSalary: 5_000, yearsOfService: 10 });

    expect(usResults.map((r) => r.name)).toEqual(['futa']);
    expect(qaResults.map((r) => r.name)).toEqual(['end_of_service_gratuity']);
  });
});
