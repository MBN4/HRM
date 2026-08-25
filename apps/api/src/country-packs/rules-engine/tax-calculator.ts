import { ExprVariable, TaxBracket, TaxLayer } from '@hrm/shared';
import { evaluateExpression } from './expression-evaluator';

export interface TaxLayerResult {
  name: string;
  amount: number;
}

export interface TaxComputationResult {
  layers: TaxLayerResult[];
  totalTax: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Standard progressive-bracket tax: each bracket's rate applies only to the slice of `taxableAmount` that falls within it. */
function computeProgressiveBracketTax(brackets: TaxBracket[], taxableAmount: number): number {
  let tax = 0;
  let previousUpTo = 0;
  for (const bracket of brackets) {
    const upTo = bracket.upTo ?? Infinity;
    const bandWidth = Math.max(0, Math.min(taxableAmount, upTo) - previousUpTo);
    tax += bandWidth * bracket.rate;
    previousUpTo = upTo;
    if (taxableAmount <= upTo) {
      break;
    }
  }
  return tax;
}

/**
 * Computes one tax layer's amount from pack DATA — brackets/rates/formulas
 * — never a code branch on which country or layer this is. `PROGRESSIVE_BRACKETS`
 * and `FLAT_RATE` are fixed, generic algorithms parameterized entirely by
 * the layer's data; `FORMULA` delegates to the sandboxed expression
 * evaluator for anything those two shapes can't express.
 */
export function computeTaxLayer(layer: TaxLayer, variables: Readonly<Partial<Record<ExprVariable, number>>>): number {
  switch (layer.kind) {
    case 'PROGRESSIVE_BRACKETS': {
      const base = variables[layer.base] ?? 0;
      return computeProgressiveBracketTax(layer.brackets, base);
    }
    case 'FLAT_RATE': {
      const base = variables[layer.base] ?? 0;
      const taxable = layer.cap !== undefined ? Math.min(base, layer.cap) : base;
      return taxable * layer.rate;
    }
    case 'FORMULA':
      return evaluateExpression(layer.formula, variables);
  }
}

/**
 * Computes every layer of a country's income tax (e.g. US federal + state +
 * FICA social security + FICA medicare, or Qatar's empty `layers: []` for
 * "no income tax") and their total. The SAME function drives every
 * country — the divergence is entirely in `layers`, supplied by the
 * resolved CountryPack.
 */
export function computeMultiLayerTax(
  layers: TaxLayer[],
  variables: Readonly<Partial<Record<ExprVariable, number>>>,
): TaxComputationResult {
  const computedLayers = layers.map((layer) => ({
    name: layer.name,
    amount: round2(computeTaxLayer(layer, variables)),
  }));
  return {
    layers: computedLayers,
    totalTax: round2(computedLayers.reduce((sum, l) => sum + l.amount, 0)),
  };
}
