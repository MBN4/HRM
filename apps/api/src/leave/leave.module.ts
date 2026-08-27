import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LEAVE_ACCRUAL_QUEUE } from '../queue/queue.constants';
import { WorkflowModule } from '../workflow/workflow.module';
import { LeaveAccrualProcessor } from './accrual/leave-accrual.processor';
import { LeaveAccrualService } from './accrual/leave-accrual.service';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { LeaveWorkflowEventsListener } from './leave-workflow-events.listener';

/**
 * The Leave module (step 1.2, Phase 1) — see docs/conventions/leave.md.
 * Imports `WorkflowModule` to inject `WorkflowEngineService` directly (a
 * leave request just starts a `WorkflowInstance` — see `LeaveService.submit`
 * and THE RULE in docs/conventions/workflow.md). `EncryptionService`/
 * `IdempotencyService`/`TenantContextService` need no explicit import — all
 * `@Global()`. `BullModule.registerQueue({name: LEAVE_ACCRUAL_QUEUE})` is
 * the SAME reusable pattern `NotificationsModule` (0.8) and
 * `EmployeesModule` (1.1) already established — see `QueueModule`'s doc
 * comment.
 */
@Module({
  imports: [
    WorkflowModule,
    BullModule.registerQueue({
      name: LEAVE_ACCRUAL_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [LeaveController],
  providers: [LeaveService, LeaveBalanceService, LeaveAccrualService, LeaveAccrualProcessor, LeaveWorkflowEventsListener],
  exports: [LeaveService],
})
export class LeaveModule {}
