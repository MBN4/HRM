import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ANALYTICS_ROLLUP_QUEUE } from '../queue/queue.constants';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsDashboardService } from './dashboard/analytics-dashboard.service';
import { AnalyticsRollupProcessor } from './rollup/analytics-rollup.processor';
import { AnalyticsRollupService } from './rollup/analytics-rollup.service';

/**
 * The Analytics dashboard module (step 1.5, Phase 1 finale) — see
 * docs/conventions/analytics-dashboard.md. `BullModule.registerQueue({name:
 * ANALYTICS_ROLLUP_QUEUE})` is the SAME reusable pattern `NotificationsModule`
 * (0.8)/`LeaveModule` (1.2)/`AttendanceModule` (1.3) already establish — see
 * `QueueModule`'s doc comment. No other Phase 0/1 module needs importing:
 * this module only READS other modules' tables directly through Prisma
 * (never their services), the same "consume the data, not the service"
 * shape `AttendanceSummaryProcessor` already takes reading `LeaveRequest`
 * for `ON_LEAVE` status.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: ANALYTICS_ROLLUP_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsDashboardService, AnalyticsRollupService, AnalyticsRollupProcessor],
})
export class AnalyticsModule {}
