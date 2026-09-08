import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { BenefitsController } from './benefits.controller';
import { BenefitPlanService } from './benefit-plan.service';
import { BenefitEnrollmentService } from './benefit-enrollment.service';
import { BenefitsStatutoryService } from './benefits-statutory.service';
import { BenefitsCostReportService } from './benefits-cost-report.service';
import { BenefitsWorkflowEventsListener } from './benefits-workflow-events.listener';

/**
 * Benefits Administration (step 3.5.2) — see
 * docs/conventions/benefits.md. Imports `WorkflowModule` to inject
 * `WorkflowEngineService` directly (an approval-gated enrollment just
 * starts a `WorkflowInstance` — THE RULE, see docs/conventions/workflow.md),
 * the SAME reuse `ExpensesModule` already establishes. Deliberately does
 * NOT import `PayrollModule`: `BenefitsStatutoryService` calls Payroll's
 * OWN free function (`resolvePayrollPackConfig`) directly, and the
 * benefits->payroll hand-off itself is the OPPOSITE direction — Payroll's
 * `PayrollRunProcessor` imports THIS module's pure
 * `benefits-payroll-input.util.ts` functions directly, never the other way
 * around (no module-level coupling either direction). `TenantContextService`
 * needs no explicit import — `@Global()`.
 */
@Module({
  imports: [WorkflowModule],
  controllers: [BenefitsController],
  providers: [BenefitPlanService, BenefitEnrollmentService, BenefitsStatutoryService, BenefitsCostReportService, BenefitsWorkflowEventsListener],
})
export class BenefitsModule {}
