import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ENGAGEMENT_CELEBRATIONS_QUEUE } from '../queue/queue.constants';
import { shouldAutorunWorkers } from '../queue/queue-worker.util';
import { CelebrationsJobData, CelebrationsService } from './celebrations.service';

/** The celebrations job's WORKER side — see `CelebrationsService` (idempotent by `celebrationKey`). */
@Processor(ENGAGEMENT_CELEBRATIONS_QUEUE, { autorun: shouldAutorunWorkers() })
export class CelebrationsProcessor extends WorkerHost {
  constructor(private readonly celebrations: CelebrationsService) {
    super();
  }

  async process(job: Job<CelebrationsJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'orchestrate') {
      await this.celebrations.enqueueForEveryLiveTenant();
      return;
    }
    await this.celebrations.generateForTenant((job.data as CelebrationsJobData).tenantId);
  }
}
