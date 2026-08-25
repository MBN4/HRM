import { z } from 'zod';
import { ALLOWED_EXPR_OPERATORS, ExprOperator } from './rules-engine.validator';

/**
 * The generic workflow/approval engine's condition sandbox (step 0.7).
 *
 * REUSES, deliberately, from 0.5's rules engine (`rules-engine.validator.ts`,
 * which this step does not modify — see /CLAUDE.md § Conventions →
 * Workflow engine): the arithmetic operator whitelist (`ALLOWED_EXPR_OPERATORS`,
 * imported here, not redefined) and — more importantly — the SECURITY
 * PATTERN itself: a fixed, closed JSON AST interpreted structurally by a
 * tree-walking evaluator, never a string parsed or `eval`'d, with no
 * mechanism for template/step data to carry executable code.
 *
 * What's DIFFERENT from 0.5's `Expr`, and why a second schema (not a
 * second UNSAFE evaluator — this is the same safe approach, extended
 * where 0.5 genuinely didn't need to go):
 *   1. Variable names are OPEN (`z.string()`), not a closed enum. 0.5's
 *      `ALLOWED_EXPR_VARIABLES` is a payroll-specific whitelist
 *      (grossSalary, yearsOfService, ...) — correct for a system with one
 *      fixed domain. The workflow engine's `dataSnapshot` is intentionally
 *      POLYMORPHIC (an expense's `amount`, a leave request's `days`, an
 *      offer's `salary`, ...) — this is not a security relaxation: the
 *      evaluator only ever does a plain, typed property lookup on an
 *      object THIS CODE already fully populated (never arbitrary property
 *      access on an untrusted object), so the safety property 0.5's name
 *      whitelist reinforces (no `var` node can reach outside intended
 *      data) holds structurally here too — an unrecognized/absent key
 *      simply fails the same "not a supplied number" check 0.5's evaluator
 *      already uses, rather than being restricted to a closed enum that
 *      would have to grow with every future consuming module (leave,
 *      expenses, ...), defeating "build one generic engine".
 *   2. There is a BOOLEAN layer (`WorkflowCondition`: compare/and/or/not)
 *      on top of the arithmetic layer (`WorkflowValueExpr`, structurally
 *      identical to 0.5's `Expr`). 0.5 never needed booleans — every
 *      formula there computes a number (a tax/statutory amount). A
 *      workflow condition is inherently a yes/no decision ("does this
 *      step apply?", "does this route to the CFO?") — arithmetic alone
 *      cannot express that, so this is a genuine, additive capability,
 *      not a rebuild of what 0.5 already solved.
 */
export const ALLOWED_COMPARE_OPERATORS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type CompareOperator = (typeof ALLOWED_COMPARE_OPERATORS)[number];

export type WorkflowValueExpr =
  | { type: 'const'; value: number }
  | { type: 'var'; name: string }
  | { type: 'binary'; op: ExprOperator; left: WorkflowValueExpr; right: WorkflowValueExpr }
  | { type: 'clamp'; value: WorkflowValueExpr; min?: WorkflowValueExpr; max?: WorkflowValueExpr };

export const workflowValueExprSchema: z.ZodType<WorkflowValueExpr> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('const'), value: z.number() }),
    z.object({ type: z.literal('var'), name: z.string().min(1) }),
    z.object({
      type: z.literal('binary'),
      op: z.enum(ALLOWED_EXPR_OPERATORS),
      left: workflowValueExprSchema,
      right: workflowValueExprSchema,
    }),
    z.object({
      type: z.literal('clamp'),
      value: workflowValueExprSchema,
      min: workflowValueExprSchema.optional(),
      max: workflowValueExprSchema.optional(),
    }),
  ]),
);

export type WorkflowCondition =
  | { type: 'compare'; op: CompareOperator; left: WorkflowValueExpr; right: WorkflowValueExpr }
  | { type: 'and'; conditions: WorkflowCondition[] }
  | { type: 'or'; conditions: WorkflowCondition[] }
  | { type: 'not'; condition: WorkflowCondition };

export const workflowConditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('compare'),
      op: z.enum(ALLOWED_COMPARE_OPERATORS),
      left: workflowValueExprSchema,
      right: workflowValueExprSchema,
    }),
    z.object({ type: z.literal('and'), conditions: z.array(workflowConditionSchema).min(1) }),
    z.object({ type: z.literal('or'), conditions: z.array(workflowConditionSchema).min(1) }),
    z.object({ type: z.literal('not'), condition: workflowConditionSchema }),
  ]),
);

/**
 * How a WorkflowStep resolves WHO may act on it — data, never a fixed
 * user baked into code. `MANAGER`/`BRANCH_HEAD`/`DEPARTMENT_HEAD` are
 * pluggable seams (see /CLAUDE.md § Conventions → Workflow engine →
 * Approver rules): resolved today against `User.managerId` / `Branch.
 * headUserId` / `Department.headUserId`, which is whatever employee/org
 * data exists before the real Employee module (phase 1.1) lands — only
 * the resolver functions in `apps/api/src/workflow/approver-resolver.service.ts`
 * should need to change when it does, never this type or the engine
 * around it. `CONDITIONAL` lets a single step pick between two entirely
 * different rules based on the instance's data (e.g. "route to the CFO
 * if amount > threshold, else the finance manager") — a DIFFERENT
 * mechanism from `WorkflowStep.condition` (which decides whether a step
 * exists in the chain AT ALL, not who approves an existing one).
 */
export type ApproverRule =
  | { type: 'SPECIFIC_USER'; userId: string }
  | { type: 'ROLE'; roleName: string }
  | { type: 'MANAGER' }
  | { type: 'BRANCH_HEAD' }
  | { type: 'DEPARTMENT_HEAD' }
  | { type: 'CONDITIONAL'; condition: WorkflowCondition; ifTrue: ApproverRule; ifFalse: ApproverRule };

export const approverRuleSchema: z.ZodType<ApproverRule> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('SPECIFIC_USER'), userId: z.string().uuid() }),
    z.object({ type: z.literal('ROLE'), roleName: z.string().min(1) }),
    z.object({ type: z.literal('MANAGER') }),
    z.object({ type: z.literal('BRANCH_HEAD') }),
    z.object({ type: z.literal('DEPARTMENT_HEAD') }),
    z.object({
      type: z.literal('CONDITIONAL'),
      condition: workflowConditionSchema,
      ifTrue: approverRuleSchema,
      ifFalse: approverRuleSchema,
    }),
  ]),
);

/**
 * `entityType` is intentionally OPEN (`z.string()`), never a closed enum —
 * enforcing a fixed catalog would mean a migration/code change every time
 * a new consuming module (leave, expenses, regularizations, offers, ...)
 * is added, which is exactly what "one generic, reusable engine" rules
 * out. Consuming modules own the meaning of their own `entityType` string
 * and `dataSnapshot` shape; the engine only ever treats both opaquely.
 */
export const startWorkflowInstanceSchema = z.object({
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  dataSnapshot: z.record(z.string(), z.unknown()),
  /** Defaults to the caller; specifying someone else requires `workflow.manage` (submitting on their behalf). */
  requesterId: z.string().uuid().optional(),
});
export type StartWorkflowInstanceInput = z.infer<typeof startWorkflowInstanceSchema>;

/** The user-initiated subset of `WorkflowActionType` — `ESCALATE`/`AUTO_APPROVE` are system-initiated and never accepted from a request body. */
export const WORKFLOW_ACTION_REQUEST_TYPES = ['APPROVE', 'REJECT', 'DELEGATE', 'COMMENT'] as const;
export type WorkflowActionRequestType = (typeof WORKFLOW_ACTION_REQUEST_TYPES)[number];

export const workflowStepActionSchema = z
  .object({
    actionType: z.enum(WORKFLOW_ACTION_REQUEST_TYPES),
    delegatedToUserId: z.string().uuid().optional(),
    comment: z.string().min(1).max(2000).optional(),
  })
  .refine((input) => input.actionType !== 'DELEGATE' || Boolean(input.delegatedToUserId), {
    message: 'delegatedToUserId is required when actionType is DELEGATE.',
    path: ['delegatedToUserId'],
  });
export type WorkflowStepActionInput = z.infer<typeof workflowStepActionSchema>;
