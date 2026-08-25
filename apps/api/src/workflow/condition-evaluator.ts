import { WorkflowCondition, WorkflowValueExpr } from '@hrm/shared';

/**
 * SECURITY BOUNDARY — the workflow engine's half of the sandbox (see
 * `packages/shared/src/validators/workflow.validator.ts`'s header comment
 * for the full write-up of what's reused from 0.5 and what's genuinely
 * new). Like 0.5's `evaluateExpression`, this is a structural, tree-
 * walking interpreter over a fixed, closed AST — no string parsing, no
 * `eval`, no `new Function`. Every node here is matched exhaustively; an
 * unrecognized node/operator, or a `var` name absent from (or non-numeric
 * in) the supplied snapshot, throws rather than silently producing a
 * wrong number/boolean.
 */
export class UnsafeWorkflowExpressionError extends Error {}

export function evaluateWorkflowValueExpr(expr: WorkflowValueExpr, variables: Readonly<Record<string, unknown>>): number {
  switch (expr.type) {
    case 'const':
      return expr.value;

    case 'var': {
      const value = variables[expr.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new UnsafeWorkflowExpressionError(`Variable "${expr.name}" was not supplied as a number.`);
      }
      return value;
    }

    case 'binary': {
      const left = evaluateWorkflowValueExpr(expr.left, variables);
      const right = evaluateWorkflowValueExpr(expr.right, variables);
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
        default:
          throw new UnsafeWorkflowExpressionError(`Operator "${expr.op}" is not in the allowed whitelist.`);
      }
    }

    case 'clamp': {
      let result = evaluateWorkflowValueExpr(expr.value, variables);
      if (expr.min) {
        result = Math.max(result, evaluateWorkflowValueExpr(expr.min, variables));
      }
      if (expr.max) {
        result = Math.min(result, evaluateWorkflowValueExpr(expr.max, variables));
      }
      return result;
    }

    default:
      throw new UnsafeWorkflowExpressionError(`Unknown expression node type "${(expr as { type: string }).type}".`);
  }
}

/**
 * Evaluates a boolean `WorkflowCondition` — what gates a `WorkflowStep`'s
 * `condition` (does this step apply to this instance?) and
 * `autoApproveCondition` (does this step need no human?), and what a
 * `CONDITIONAL` approver rule branches on. Numeric comparisons only —
 * same scope boundary as 0.5's purely-numeric formulas; a future need for
 * e.g. string equality would be a deliberate, reviewed extension here,
 * not a workaround elsewhere.
 */
export function evaluateWorkflowCondition(condition: WorkflowCondition, variables: Readonly<Record<string, unknown>>): boolean {
  switch (condition.type) {
    case 'compare': {
      const left = evaluateWorkflowValueExpr(condition.left, variables);
      const right = evaluateWorkflowValueExpr(condition.right, variables);
      switch (condition.op) {
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        default:
          throw new UnsafeWorkflowExpressionError(`Comparison operator "${condition.op}" is not in the allowed whitelist.`);
      }
    }

    case 'and':
      return condition.conditions.every((c) => evaluateWorkflowCondition(c, variables));

    case 'or':
      return condition.conditions.some((c) => evaluateWorkflowCondition(c, variables));

    case 'not':
      return !evaluateWorkflowCondition(condition.condition, variables);

    default:
      throw new UnsafeWorkflowExpressionError(`Unknown condition node type "${(condition as { type: string }).type}".`);
  }
}
