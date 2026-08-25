import { TaxLayer } from '@hrm/shared';
import { USA_PACK, QATAR_PACK } from '@hrm/db';
import { computeMultiLayerTax, computeTaxLayer } from './tax-calculator';

describe('computeTaxLayer', () => {
  it('computes progressive brackets: only the slice of income within each band is taxed at that band\'s rate', () => {
    const layer: TaxLayer = {
      name: 'test_progressive',
      kind: 'PROGRESSIVE_BRACKETS',
      base: 'annualSalary',
      brackets: [
        { upTo: 10_000, rate: 0.1 },
        { upTo: 20_000, rate: 0.2 },
        { upTo: null, rate: 0.3 },
      ],
    };
    // 10,000 @ 10% + 10,000 @ 20% + 5,000 @ 30% = 1,000 + 2,000 + 1,500 = 4,500
    expect(computeTaxLayer(layer, { annualSalary: 25_000 })).toBeCloseTo(4_500);
  });

  it('computes a flat rate with a wage-base cap (e.g. FICA social security)', () => {
    const layer: TaxLayer = { name: 'test_flat', kind: 'FLAT_RATE', base: 'annualSalary', rate: 0.062, cap: 100_000 };
    expect(computeTaxLayer(layer, { annualSalary: 250_000 })).toBeCloseTo(100_000 * 0.062);
    expect(computeTaxLayer(layer, { annualSalary: 50_000 })).toBeCloseTo(50_000 * 0.062);
  });

  it('computes a FORMULA layer via the sandboxed expression evaluator', () => {
    const layer: TaxLayer = {
      name: 'test_formula',
      kind: 'FORMULA',
      formula: { type: 'binary', op: '*', left: { type: 'var', name: 'annualSalary' }, right: { type: 'const', value: 0.05 } },
    };
    expect(computeTaxLayer(layer, { annualSalary: 40_000 })).toBeCloseTo(2_000);
  });
});

describe('computeMultiLayerTax — the same function drives every country, only the DATA differs', () => {
  it('computes a real multi-layer US example (federal + state + FICA social security + FICA medicare)', () => {
    const result = computeMultiLayerTax(USA_PACK.tax.layers, { annualSalary: 100_000 });

    const byName = Object.fromEntries(result.layers.map((l) => [l.name, l.amount]));
    // Federal: 11,600@10% + (47,150-11,600)@12% + (100,000-47,150)@22%
    //        = 1,160 + 4,266 + 11,627 = 17,053
    expect(byName.federal_income_tax).toBeCloseTo(17_053);
    // State: flat 5% of 100,000
    expect(byName.state_income_tax).toBeCloseTo(5_000);
    // FICA social security: 6.2% of 100,000 (under the 168,600 cap)
    expect(byName.fica_social_security).toBeCloseTo(6_200);
    // FICA medicare: 1.45% of 100,000, uncapped
    expect(byName.fica_medicare).toBeCloseTo(1_450);

    expect(result.totalTax).toBeCloseTo(17_053 + 5_000 + 6_200 + 1_450);
  });

  it('caps FICA social security at the wage base but not medicare, for a high earner', () => {
    const result = computeMultiLayerTax(USA_PACK.tax.layers, { annualSalary: 300_000 });
    const byName = Object.fromEntries(result.layers.map((l) => [l.name, l.amount]));

    expect(byName.fica_social_security).toBeCloseTo(168_600 * 0.062);
    expect(byName.fica_medicare).toBeCloseTo(300_000 * 0.0145);
  });

  it('Qatar has NO income tax layers at all — an empty array, not a country-code branch that skips computing tax', () => {
    expect(QATAR_PACK.tax.layers).toEqual([]);
    const result = computeMultiLayerTax(QATAR_PACK.tax.layers, { annualSalary: 300_000 });
    expect(result.layers).toEqual([]);
    expect(result.totalTax).toBe(0);
  });
});
