import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { PayrollModule } from '../payroll/payroll.module';
import { ExpensesController } from './expenses.controller';
import { ExpenseCategoryService } from './expense-category.service';
import { ExpenseClaimService } from './expense-claim.service';
import { ExpenseWorkflowEventsListener } from './expense-workflow-events.listener';

/**
 * The Expenses & Reimbursements module (step 3.1) — see
 * docs/conventions/operations-modules.md. Imports `WorkflowModule` (a
 * claim's approval just starts a `WorkflowInstance` — THE RULE) and
 * `PayrollModule` (reuses `ExchangeRateService` for the SAME Decimal/
 * currency-rollup approach Payroll itself already uses; the actual
 * reimbursement hand-off is an ADDITIVE touch inside `PayrollRunProcessor`,
 * not a call this module makes — see that file's own doc comment).
 * `StorageService`/`TenantContextService` need no explicit import — both
 * `@Global()`.
 */
@Module({
  imports: [WorkflowModule, PayrollModule],
  controllers: [ExpensesController],
  providers: [ExpenseCategoryService, ExpenseClaimService, ExpenseWorkflowEventsListener],
  exports: [ExpenseClaimService],
})
export class ExpensesModule {}
