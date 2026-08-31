import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PERFORMANCE_CALIBRATION_QUEUE } from '../../queue/queue.constants';

export interface CalibrationRecomputeJobData {
  tenantId: string;
  cycleId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * Producer side of the calibration rollup — see
 * docs/conventions/performance.md and analytics-dashboard.md (the SAME
 * pre-aggregation discipline). Enqueued once per appraisal that reaches
 * `COMPLETED` (`AppraisalWorkflowEventsListener`) and by the manual
 * backfill/test lever (`POST /performance/cycles/:id/calibration/recompute`,
 * the same shape `AnalyticsController`'s own `POST /analytics/rollup/run`
 * already establishes). A full recompute is naturally idempotent (see
 * `CalibrationProcessor`), so firing it once per completed appraisal rather
 * than debouncing is simple and correct, just slightly more work than
 * strictly necessary under heavy concurrent sign-off — an accepted
 * tradeoff at this module's scale.
 */
@Injectable()
export class CalibrationQueueService {
  constructor(@InjectQueue(PERFORMANCE_CALIBRATION_QUEUE) private readonly queue: Queue<CalibrationRecomputeJobData>) {}

  async enqueueRecompute(tenantId: string, cycleId: string): Promise<void> {
    await this.queue.add('recompute-cycle', { tenantId, cycleId }, JOB_OPTIONS);
  }
}
