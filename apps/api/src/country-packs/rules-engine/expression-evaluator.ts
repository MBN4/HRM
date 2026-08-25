import { ALLOWED_EXPR_OPERATORS, ALLOWED_EXPR_VARIABLES, Expr, ExprVariable } from '@hrm/shared';

/**
 * Thrown for any expression node that falls outside the fixed whitelist —
 * an unknown node `type`, an operator not in `ALLOWED_EXPR_OPERATORS`, or a
 * variable not in `ALLOWED_EXPR_VARIABLES`. Never caught-and-ignored by
 * callers: an unsafe expression must fail the whole tax/statutory
 * computation, not silently compute a wrong number.
 */
export class UnsafeExpressionError extends Error {}

/**
 * SECURITY BOUNDARY — the actual sandbox.
 *
 * This is the ONLY function that executes CountryPack/TenantOverride
 * "formula" data. It is a structural (tree-walking) interpreter over the
 * closed `Expr` AST defined in `@hrm/shared`'s rules-engine validator —
 * there is no string parsing, no `eval`, no `new Function`, and no
 * mechanism by which pack/override data could reach arbitrary JavaScript
 * execution. Every node is matched exhaustively against the same
 * whitelist `@hrm/shared`'s `exprSchema` already validated the data
 * against at write- and read-time; this is the second, independent check
 * (defense in depth — this project's stated security posture is that no
 * single layer is trusted alone). An `Expr` value that has somehow reached
 * this function without going through that schema (e.g. a future caller
 * that forgets to validate) is still safe: any node/operator/variable
 * outside the whitelist throws `UnsafeExpressionError` instead of being
 * silently executed.
 *
 * `variables` must supply every variable name the expression can
 * reference; a variable present in the whitelist but missing from
 * `variables` also throws, rather than silently defaulting to 0 or
 * `NaN`-propagating.
 */
export function evaluateExpression(expr: Expr, variables: Readonly<Partial<Record<ExprVariable, number>>>): number {
  switch (expr.type) {
    case 'const':
      return expr.value;

    case 'var': {
      if (!(ALLOWED_EXPR_VARIABLES as readonly string[]).includes(expr.name)) {
        throw new UnsafeExpressionError(`Variable "${expr.name}" is not in the allowed whitelist.`);
      }
      const value = variables[expr.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new UnsafeExpressionError(`Variable "${expr.name}" was not supplied to the evaluator.`);
      }
      return value;
    }

    case 'binary': {
      if (!(ALLOWED_EXPR_OPERATORS as readonly string[]).includes(expr.op)) {
        throw new UnsafeExpressionError(`Operator "${expr.op}" is not in the allowed whitelist.`);
      }
      const left = evaluateExpression(expr.left, variables);
      const right = evaluateExpression(expr.right, variables);
      switch (expr.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? 0 : left / right;
        case 'min':
          return Math.min(left, right);
        case 'max':
          return Math.max(left, right);
      }
      break;
    }

    case 'clamp': {
      let result = evaluateExpression(expr.value, variables);
      if (expr.min) {
        result = Math.max(result, evaluateExpression(expr.min, variables));
      }
      if (expr.max) {
        result = Math.min(result, evaluateExpression(expr.max, variables));
      }
      return result;
    }
  }

  // Exhaustive over the `Expr` union at the type level; a value reaching
  // here at runtime means the whitelist was bypassed upstream (e.g. data
  // read from the DB without schema validation) — refuse it rather than
  // guessing at a result.
  throw new UnsafeExpressionError(`Unknown expression node type "${(expr as { type: string }).type}".`);
}
