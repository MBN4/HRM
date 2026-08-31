import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PERFORMANCE_CALIBRATION_QUEUE } from '../queue/queue.constants';
import { WorkflowModule } from '../workflow/workflow.module';
import { PerformanceController } from './performance.controller';
import { RatingScaleService } from './rating-scales/rating-scale.service';
import { AppraisalCycleService } from './cycles/appraisal-cycle.service';
import { GoalService } from './goals/goal.service';
import { AppraisalService } from './appraisals/appraisal.service';
import { AppraisalWorkflowEventsListener } from './appraisals/appraisal-workflow-events.listener';
import { ReviewService } from './reviews/review.service';
import { CalibrationQueueService } from './calibration/calibration-queue.service';
import { CalibrationProcessor } from './calibration/calibration.processor';
import { CalibrationService } from './calibration/calibration.service';

/**
 * The Performance module (step 2.2, Phase 2) — a THIN CONSUMER of existing
 * systems, see docs/conventions/performance.md. Imports `WorkflowModule` to
 * inject `WorkflowEngineService` directly (an appraisal's sign-off just
 * starts a `WorkflowInstance` — THE RULE, see docs/conventions/workflow.md),
 * the SAME reuse `LeaveModule`/`AttendanceModule`/`PayrollModule` already
 * establish. `BullModule.registerQueue({name: PERFORMANCE_CALIBRATION_QUEUE})`
 * is the SAME reusable pattern every other queue-backed module already
 * establishes — see `QueueModule`'s doc comment. No feature-flag gating
 * (unlike Payroll's ENTERPRISE-only flag) — this module is RBAC-gated only,
 * the same posture Leave/Attendance/Employee already take.
 */
@Module({
  imports: [
    WorkflowModule,
    BullModule.registerQueue({
      name: PERFORMANCE_CALIBRATION_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [PerformanceController],
  providers: [
    RatingScaleService,
    AppraisalCycleService,
    GoalService,
    AppraisalService,
    AppraisalWorkflowEventsListener,
    ReviewService,
    CalibrationQueueService,
    CalibrationProcessor,
    CalibrationService,
  ],
  exports: [AppraisalService],
})
export class PerformanceModule {}
