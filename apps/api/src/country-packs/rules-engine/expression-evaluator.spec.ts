import { Expr } from '@hrm/shared';
import { evaluateExpression, UnsafeExpressionError } from './expression-evaluator';

describe('evaluateExpression', () => {
  it('evaluates a const node', () => {
    expect(evaluateExpression({ type: 'const', value: 42 }, {})).toBe(42);
  });

  it('evaluates a var node from the supplied variables', () => {
    expect(evaluateExpression({ type: 'var', name: 'grossSalary' }, { grossSalary: 5000 })).toBe(5000);
  });

  it.each([
    ['+', 3, 4, 7],
    ['-', 10, 4, 6],
    ['*', 3, 4, 12],
    ['/', 12, 4, 3],
    ['min', 3, 4, 3],
    ['max', 3, 4, 4],
  ] as const)('evaluates binary %s', (op, left, right, expected) => {
    const expr: Expr = { type: 'binary', op, left: { type: 'const', value: left }, right: { type: 'const', value: right } };
    expect(evaluateExpression(expr, {})).toBe(expected);
  });

  it('divides by zero as zero, rather than throwing or returning Infinity/NaN', () => {
    const expr: Expr = { type: 'binary', op: '/', left: { type: 'const', value: 10 }, right: { type: 'const', value: 0 } };
    expect(evaluateExpression(expr, {})).toBe(0);
  });

  it('clamps a value between an optional min and max', () => {
    const expr: Expr = {
      type: 'clamp',
      value: { type: 'const', value: 150 },
      min: { type: 'const', value: 0 },
      max: { type: 'const', value: 100 },
    };
    expect(evaluateExpression(expr, {})).toBe(100);
  });

  it('composes nested binary/clamp/var nodes', () => {
    // clamp(grossSalary * 0.1, 0, 500)
    const expr: Expr = {
      type: 'clamp',
      value: { type: 'binary', op: '*', left: { type: 'var', name: 'grossSalary' }, right: { type: 'const', value: 0.1 } },
      max: { type: 'const', value: 500 },
    };
    expect(evaluateExpression(expr, { grossSalary: 10_000 })).toBe(500);
    expect(evaluateExpression(expr, { grossSalary: 1_000 })).toBe(100);
  });

  describe('the sandbox: rejects anything outside the fixed whitelist', () => {
    it('throws for a variable not supplied at evaluation time', () => {
      expect(() => evaluateExpression({ type: 'var', name: 'yearsOfService' }, {})).toThrow(UnsafeExpressionError);
    });

    it('throws for a variable name not in the whitelist, even if it slipped past static typing', () => {
      const expr = { type: 'var', name: '__proto__' } as unknown as Expr;
      expect(() => evaluateExpression(expr, { __proto__: 1 } as never)).toThrow(UnsafeExpressionError);
    });

    it('throws for an operator not in the whitelist', () => {
      const expr = {
        type: 'binary',
        op: 'eval',
        left: { type: 'const', value: 1 },
        right: { type: 'const', value: 1 },
      } as unknown as Expr;
      expect(() => evaluateExpression(expr, {})).toThrow(UnsafeExpressionError);
    });

    it('throws for an unknown node type — proves there is no fallthrough that executes arbitrary data', () => {
      const expr = { type: 'exec', code: 'process.exit(1)' } as unknown as Expr;
      expect(() => evaluateExpression(expr, {})).toThrow(UnsafeExpressionError);
    });

    it('a formula can never reach outside the variables object it is given (no closure/global access)', () => {
      // Even if a malicious pack author could smuggle a "global"-looking variable name past the
      // static Expr type, the whitelist check on `var` nodes rejects it before any lookup happens.
      const expr = { type: 'var', name: 'process' } as unknown as Expr;
      expect(() => evaluateExpression(expr, {})).toThrow(UnsafeExpressionError);
    });
  });
});
