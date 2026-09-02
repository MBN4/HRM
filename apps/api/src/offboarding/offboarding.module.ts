import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { EmployeesModule } from '../employees/employees.module';
import { ChecklistsModule } from '../checklists/checklists.module';
import { PayrollModule } from '../payroll/payroll.module';
import { AuthModule } from '../auth/auth.module';
import { AssetsModule } from '../assets/assets.module';
import { OffboardingController } from './offboarding.controller';
import { OffboardingService } from './offboarding.service';
import { OffboardingWorkflowEventsListener } from './offboarding-workflow-events.listener';

/**
 * The Offboarding module (step 2.3) — see
 * docs/conventions/recruitment-lifecycle.md. Imports `WorkflowModule`
 * (sign-off, THE RULE), `EmployeesModule` (the REAL, UNMODIFIED
 * `EmployeeService.update` status transition), `ChecklistsModule` (the
 * shared clearance-checklist engine), `PayrollModule` (the REAL,
 * UNMODIFIED `PayrollRunService` lifecycle for the `FINAL_SETTLEMENT`
 * hand-off), `AuthModule` (the REAL `TokenService.revokeAllForUser`
 * for access revocation), and — additive, step 3.1 — `AssetsModule`, so
 * the clearance checklist's "asset return" task can be wired to the REAL
 * asset register instead of staying a placeholder manual tick-box; see
 * docs/conventions/operations-modules.md.
 */
@Module({
  imports: [WorkflowModule, EmployeesModule, ChecklistsModule, PayrollModule, AuthModule, AssetsModule],
  controllers: [OffboardingController],
  providers: [OffboardingService, OffboardingWorkflowEventsListener],
  exports: [OffboardingService],
})
export class OffboardingModule {}
