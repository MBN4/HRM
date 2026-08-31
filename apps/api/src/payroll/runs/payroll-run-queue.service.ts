import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PAYROLL_RUN_QUEUE } from '../../queue/queue.constants';

export interface PayrollRunJobData {
  tenantId: string;
  payrollRunId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The run-calculation job's PRODUCER side — mirrors
 * `AttendanceSummaryService`/`LeaveAccrualService`: enqueue one job,
 * return immediately, the actual per-employee work happens in
 * `PayrollRunProcessor`, off any request path (payroll is explicitly
 * "heavy → queued" per this step's brief). `attempts: 5` with exponential
 * backoff is BullMQ's own retry — combined with the processor's per-
 * employee resumability check, a retried job never reprocesses an
 * employee that already succeeded.
 */
@Injectable()
export class PayrollRunQueueService {
  constructor(@InjectQueue(PAYROLL_RUN_QUEUE) private readonly queue: Queue<PayrollRunJobData>) {}

  async enqueueCalculate(tenantId: string, payrollRunId: string): Promise<void> {
    await this.queue.add('calculate', { tenantId, payrollRunId }, JOB_OPTIONS);
  }
}
