import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ATTENDANCE_SUMMARY_QUEUE } from '../queue/queue.constants';
import { WorkflowModule } from '../workflow/workflow.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceClockService } from './clock/attendance-clock.service';
import { BIOMETRIC_DEVICE_ADAPTER } from './devices/biometric-device.interface';
import { ManualBiometricDeviceAdapter } from './devices/manual-biometric-device.adapter';
import { AttendanceRegularizationController } from './regularization/attendance-regularization.controller';
import { AttendanceRegularizationService } from './regularization/attendance-regularization.service';
import { AttendanceRegularizationWorkflowEventsListener } from './regularization/attendance-regularization-workflow-events.listener';
import { ShiftResolutionService } from './shifts/shift-resolution.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { AttendanceSummaryProcessor } from './summary/attendance-summary.processor';
import { AttendanceSummaryService } from './summary/attendance-summary.service';

/**
 * The Attendance & time-tracking module (step 1.3, Phase 1) — see
 * docs/conventions/attendance.md. Imports `WorkflowModule` to inject
 * `WorkflowEngineService` directly (a regularization just starts a
 * `WorkflowInstance` — see `AttendanceRegularizationService.submit` and THE
 * RULE in docs/conventions/workflow.md), the SAME reuse `LeaveModule` (1.2)
 * already established. `StorageService`/`TenantContextService` need no
 * explicit import — both `StorageModule`/`TenancyModule` are `@Global()`.
 *
 * `BullModule.registerQueue({name: ATTENDANCE_SUMMARY_QUEUE})` is the SAME
 * reusable pattern `NotificationsModule` (0.8)/`EmployeesModule` (1.1)/
 * `LeaveModule` (1.2) already established — see `QueueModule`'s doc
 * comment. `BIOMETRIC_DEVICE_ADAPTER` binds to `ManualBiometricDeviceAdapter`
 * today — the SAME "swap one DI binding, no caller changes" seam pattern
 * 0.4's `AUTH_PROVIDER`/0.8's `NotificationProvider`s already establish; a
 * real device integration changes only this one binding.
 */
@Module({
  imports: [
    WorkflowModule,
    BullModule.registerQueue({
      name: ATTENDANCE_SUMMARY_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [AttendanceController, ShiftsController, AttendanceRegularizationController],
  providers: [
    AttendanceClockService,
    ShiftResolutionService,
    ShiftsService,
    AttendanceSummaryService,
    AttendanceSummaryProcessor,
    AttendanceRegularizationService,
    AttendanceRegularizationWorkflowEventsListener,
    { provide: BIOMETRIC_DEVICE_ADAPTER, useClass: ManualBiometricDeviceAdapter },
  ],
  // BIOMETRIC_DEVICE_ADAPTER additionally exported (step 3.3) so
  // Integrations' BiometricModule can formalize a real per-tenant device
  // registry + ingestion endpoint around this EXACT existing seam without
  // this module (or ManualBiometricDeviceAdapter itself) changing at all —
  // the same "consumer imports the reused module" direction
  // operations-modules.md's Expense→Payroll `ExchangeRateService` export
  // already establishes.
  exports: [AttendanceClockService, BIOMETRIC_DEVICE_ADAPTER],
})
export class AttendanceModule {}
