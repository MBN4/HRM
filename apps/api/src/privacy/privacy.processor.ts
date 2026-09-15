import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PRIVACY_QUEUE } from '../queue/queue.constants';
import { shouldAutorunWorkers } from '../queue/queue-worker.util';
import { DataSubjectRequestService, type PrivacyJobData } from './data-subject-request.service';
import { RetentionEnforcementService } from './retention-enforcement.service';

/**
 * The `privacy` queue's worker — ONE queue, THREE job names, the SAME
 * "share a processor, dispatch by job.name" shape `MigrationProcessor`
 * already establishes for its own `validate`/`commit` pair (see
 * docs/conventions/data-migration.md): `export`/`erasure` are on-demand,
 * one-shot jobs enqueued by `DataSubjectRequestService.submit`;
 * `retention-sweep` is the scheduled repeatable job
 * `RetentionEnforcementService` registers on `onModuleInit`. All three
 * share the same underlying erasure/export engines, never a second
 * implementation.
 */
@Processor(PRIVACY_QUEUE, { autorun: shouldAutorunWorkers() })
export class PrivacyProcessor extends WorkerHost {
  constructor(
    private readonly requests: DataSubjectRequestService,
    private readonly retention: RetentionEnforcementService,
  ) {
    super();
  }

  async process(job: Job<PrivacyJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'export') {
      const { tenantId, requestId } = job.data as PrivacyJobData;
      await this.requests.processExport(tenantId, requestId);
    } else if (job.name === 'erasure') {
      const { tenantId, requestId } = job.data as PrivacyJobData;
      await this.requests.processErasure(tenantId, requestId);
    } else if (job.name === 'retention-sweep') {
      await this.retention.runSweep();
    }
  }
}
