import { z } from 'zod';

/**
 * Expenses & Reimbursements (step 3.1) — see
 * docs/conventions/operations-modules.md. A claim is DRAFT -> SUBMITTED ->
 * (the REAL 0.7 workflow, `entityType: "EXPENSE_CLAIM"`) -> APPROVED/
 * REJECTED -> (Payroll's own reimbursement hand-off) -> REIMBURSED. Policy
 * limits live as tenant-configurable DATA on `ExpenseCategory`, never
 * hardcoded — enforced by `ExpenseClaimService.submit`.
 */
export const createExpenseCategorySchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    policyLimitAmount: z.number().positive().optional(),
  })
  .strict();
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const expenseLineInputSchema = z
  .object({
    categoryId: z.string().uuid(),
    description: z.string().min(1).max(500),
    amount: z.number().positive(),
    expenseDate: z.coerce.date(),
  })
  .strict();
export type ExpenseLineInput = z.infer<typeof expenseLineInputSchema>;

export const createExpenseClaimSchema = z
  .object({
    lines: z.array(expenseLineInputSchema).min(1, 'An expense claim needs at least one line item.'),
  })
  .strict();
export type CreateExpenseClaimInput = z.infer<typeof createExpenseClaimSchema>;
