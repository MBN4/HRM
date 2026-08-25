import { WorkflowCondition, WorkflowValueExpr } from '@hrm/shared';
import { evaluateWorkflowCondition, evaluateWorkflowValueExpr, UnsafeWorkflowExpressionError } from './condition-evaluator';

describe('evaluateWorkflowValueExpr', () => {
  it('evaluates const/var/binary/clamp nodes against an open, polymorphic snapshot', () => {
    expect(evaluateWorkflowValueExpr({ type: 'const', value: 42 }, {})).toBe(42);
    expect(evaluateWorkflowValueExpr({ type: 'var', name: 'amount' }, { amount: 500 })).toBe(500);
    expect(evaluateWorkflowValueExpr({ type: 'var', name: 'days' }, { days: 3, leaveType: 'ANNUAL' })).toBe(3);

    const expr: WorkflowValueExpr = {
      type: 'binary',
      op: '*',
      left: { type: 'var', name: 'amount' },
      right: { type: 'const', value: 0.1 },
    };
    expect(evaluateWorkflowValueExpr(expr, { amount: 200 })).toBe(20);

    const clamped: WorkflowValueExpr = { type: 'clamp', value: { type: 'const', value: 150 }, max: { type: 'const', value: 100 } };
    expect(evaluateWorkflowValueExpr(clamped, {})).toBe(100);
  });

  describe('the sandbox: rejects anything outside the fixed whitelist', () => {
    it('throws for a variable absent from the snapshot', () => {
      expect(() => evaluateWorkflowValueExpr({ type: 'var', name: 'amount' }, {})).toThrow(UnsafeWorkflowExpressionError);
    });

    it('throws for a variable present but non-numeric (e.g. a string field from the same snapshot)', () => {
      expect(() => evaluateWorkflowValueExpr({ type: 'var', name: 'leaveType' }, { leaveType: 'ANNUAL' })).toThrow(
        UnsafeWorkflowExpressionError,
      );
    });

    it('throws for an operator not in the whitelist', () => {
      const expr = { type: 'binary', op: 'eval', left: { type: 'const', value: 1 }, right: { type: 'const', value: 1 } } as unknown as WorkflowValueExpr;
      expect(() => evaluateWorkflowValueExpr(expr, {})).toThrow(UnsafeWorkflowExpressionError);
    });

    it('throws for an unknown node type — no fallthrough that executes arbitrary data', () => {
      const expr = { type: 'exec', code: 'process.exit(1)' } as unknown as WorkflowValueExpr;
      expect(() => evaluateWorkflowValueExpr(expr, {})).toThrow(UnsafeWorkflowExpressionError);
    });
  });
});

describe('evaluateWorkflowCondition', () => {
  it.each([
    ['>', 200, 100, true],
    ['>=', 100, 100, true],
    ['<', 50, 100, true],
    ['<=', 100, 100, true],
    ['==', 100, 100, true],
    ['!=', 100, 200, true],
  ] as const)('compare %s', (op, amount, threshold, expected) => {
    const condition: WorkflowCondition = {
      type: 'compare',
      op,
      left: { type: 'var', name: 'amount' },
      right: { type: 'const', value: threshold },
    };
    expect(evaluateWorkflowCondition(condition, { amount })).toBe(expected);
  });

  it('composes and/or/not', () => {
    const condition: WorkflowCondition = {
      type: 'and',
      conditions: [
        { type: 'compare', op: '>', left: { type: 'var', name: 'amount' }, right: { type: 'const', value: 100 } },
        {
          type: 'not',
          condition: { type: 'compare', op: '>', left: { type: 'var', name: 'days' }, right: { type: 'const', value: 30 } },
        },
      ],
    };
    expect(evaluateWorkflowCondition(condition, { amount: 500, days: 5 })).toBe(true);
    expect(evaluateWorkflowCondition(condition, { amount: 500, days: 60 })).toBe(false);

    const orCondition: WorkflowCondition = {
      type: 'or',
      conditions: [
        { type: 'compare', op: '>', left: { type: 'var', name: 'amount' }, right: { type: 'const', value: 100000 } },
        { type: 'compare', op: '==', left: { type: 'var', name: 'days' }, right: { type: 'const', value: 5 } },
      ],
    };
    expect(evaluateWorkflowCondition(orCondition, { amount: 1, days: 5 })).toBe(true);
  });

  it('throws for an unknown condition node type', () => {
    const condition = { type: 'exec', code: 'process.exit(1)' } as unknown as WorkflowCondition;
    expect(() => evaluateWorkflowCondition(condition, {})).toThrow(UnsafeWorkflowExpressionError);
  });

  it('throws for a comparison operator outside the whitelist', () => {
    const condition = {
      type: 'compare',
      op: '===',
      left: { type: 'const', value: 1 },
      right: { type: 'const', value: 1 },
    } as unknown as WorkflowCondition;
    expect(() => evaluateWorkflowCondition(condition, {})).toThrow(UnsafeWorkflowExpressionError);
  });
});
