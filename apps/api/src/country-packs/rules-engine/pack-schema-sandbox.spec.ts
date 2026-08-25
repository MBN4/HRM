import { exprSchema } from '@hrm/shared';

/**
 * `@hrm/shared` has no jest setup of its own (see its package.json) —
 * these live here, alongside the evaluator's own sandbox tests, since
 * `apps/api` already depends on `@hrm/shared` and already runs jest.
 *
 * This is the OTHER half of the sandbox from
 * `expression-evaluator.spec.ts`'s "the sandbox" tests: `exprSchema` is
 * what CountryPack/TenantOverride JSON is validated against on every
 * write and read (see CountryPackResolutionService), so out-of-whitelist
 * data should never even reach `evaluateExpression` in the first place.
 * Both layers reject it independently — defense in depth, not redundancy.
 */
describe('exprSchema — the write/read-time half of the sandbox', () => {
  it('accepts every whitelisted node shape', () => {
    expect(exprSchema.safeParse({ type: 'const', value: 1 }).success).toBe(true);
    expect(exprSchema.safeParse({ type: 'var', name: 'grossSalary' }).success).toBe(true);
    expect(
      exprSchema.safeParse({
        type: 'binary',
        op: '+',
        left: { type: 'const', value: 1 },
        right: { type: 'const', value: 2 },
      }).success,
    ).toBe(true);
    expect(
      exprSchema.safeParse({ type: 'clamp', value: { type: 'const', value: 1 }, max: { type: 'const', value: 2 } })
        .success,
    ).toBe(true);
  });

  it('rejects a variable name outside the fixed whitelist', () => {
    expect(exprSchema.safeParse({ type: 'var', name: 'process' }).success).toBe(false);
    expect(exprSchema.safeParse({ type: 'var', name: '__proto__' }).success).toBe(false);
  });

  it('rejects an operator outside the fixed whitelist', () => {
    expect(
      exprSchema.safeParse({
        type: 'binary',
        op: 'eval',
        left: { type: 'const', value: 1 },
        right: { type: 'const', value: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects a node shape carrying arbitrary code as a string — there is no "formula string" escape hatch', () => {
    expect(
      exprSchema.safeParse({ type: 'formula_string', code: 'require("child_process").execSync("id")' }).success,
    ).toBe(false);
    expect(exprSchema.safeParse('require("child_process")').success).toBe(false);
  });

  it('rejects an unknown node type entirely', () => {
    expect(exprSchema.safeParse({ type: 'exec', code: 'process.exit(1)' }).success).toBe(false);
  });
});
