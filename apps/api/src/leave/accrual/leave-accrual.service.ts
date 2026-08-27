import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { LEAVE_ACCRUAL_QUEUE } from '../../queue/queue.constants';

export interface LeaveAccrualJobData {
  tenantId: string;
  periodYear: number;
  periodMonth: number;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The accrual job's PRODUCER side — mirrors 0.8's `NotificationsService`/
 * 1.1's `EmployeeImportService` shape: enqueue one job, return immediately,
 * the actual per-employee work happens in `LeaveAccrualProcessor`, off any
 * request path. Not wired to a real cron/scheduler yet — the SAME
 * documented, accepted tradeoff 0.7's `WorkflowEscalationService.
 * sweepOverdueSteps` already takes ("scheduling infrastructure is out of
 * this step's scope... safe to call repeatedly/concurrently" — see
 * docs/conventions/workflow.md): `POST /leave/accrual/run` is today's
 * manual trigger (an HR/admin lever, or what a real cron would call), and
 * `LeaveAccrualProcessor`'s per-employee idempotency guard makes an
 * accidental double-trigger for the same period harmless.
 */
@Injectable()
export class LeaveAccrualService {
  constructor(@InjectQueue(LEAVE_ACCRUAL_QUEUE) private readonly queue: Queue<LeaveAccrualJobData>) {}

  async enqueueRun(tenantId: string, periodYear: number, periodMonth: number): Promise<void> {
    await this.queue.add('run', { tenantId, periodYear, periodMonth }, JOB_OPTIONS);
  }
}
