import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { STATUTORY_REPORT_QUEUE } from '../queue/queue.constants';

export interface StatutoryReportJobData {
  tenantId: string;
  generatedReportId: string;
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The report-generation job's PRODUCER side — the SAME "enqueue one job,
 * return immediately, the real work happens in the WorkerHost" shape
 * `PayrollRunQueueService` already establishes (report generation is
 * explicitly "a BullMQ job for larger orgs" per this step's brief — see
 * docs/conventions/statutory-reporting.md).
 */
@Injectable()
export class StatutoryReportQueueService {
  constructor(@InjectQueue(STATUTORY_REPORT_QUEUE) private readonly queue: Queue<StatutoryReportJobData>) {}

  async enqueueGenerate(tenantId: string, generatedReportId: string): Promise<void> {
    await this.queue.add('generate', { tenantId, generatedReportId }, JOB_OPTIONS);
  }
}
