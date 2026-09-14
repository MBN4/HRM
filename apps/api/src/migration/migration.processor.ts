import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MIGRATION_QUEUE } from '../queue/queue.constants';
import { shouldAutorunWorkers } from '../queue/queue-worker.util';
import type { MigrationJobData } from './import-batch.service';
import { MigrationProcessingService } from './migration-processing.service';

/**
 * The `migration` queue's worker — the 0.8 BullMQ pattern, reused as-is
 * (see `QueueModule`'s doc comment). ONE queue with two job NAMES
 * (`validate`/`commit`) rather than two queues — they share the identical
 * "load the batch, parse the file, run every row through the same
 * importer" shape, differing only in the `commit` boolean threaded through
 * `MigrationProcessingService`; splitting them into two queues would just
 * be two `@Processor()` classes forwarding to the same service.
 */
@Processor(MIGRATION_QUEUE, { autorun: shouldAutorunWorkers() })
export class MigrationProcessor extends WorkerHost {
  constructor(private readonly processing: MigrationProcessingService) {
    super();
  }

  async process(job: Job<MigrationJobData>): Promise<void> {
    const { tenantId, batchId } = job.data;
    if (job.name === 'validate') {
      await this.processing.runDryRun(tenantId, batchId);
    } else if (job.name === 'commit') {
      await this.processing.runCommit(tenantId, batchId);
    }
  }
}
