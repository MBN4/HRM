import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BILLING_SEAT_SYNC_QUEUE } from '../../queue/queue.constants';
import { shouldAutorunWorkers } from '../../queue/queue-worker.util';
import type { BillingSeatSyncJobData } from './billing-seat-metering.service';
import { BillingSeatMeteringService } from './billing-seat-metering.service';

/** Worker side — see BillingSeatMeteringService's doc comment. Two job names share this processor, the SAME `orchestrate`/`<work>` split AnalyticsRollupProcessor already establishes. */
@Processor(BILLING_SEAT_SYNC_QUEUE, { autorun: shouldAutorunWorkers() })
export class BillingSeatMeteringProcessor extends WorkerHost {
  constructor(private readonly seatMetering: BillingSeatMeteringService) {
    super();
  }

  async process(job: Job<BillingSeatSyncJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'orchestrate') {
      await this.seatMetering.enqueueForEveryBilledTenant();
      return;
    }
    const { tenantId } = job.data as BillingSeatSyncJobData;
    await this.seatMetering.syncTenantSeats(tenantId);
  }
}
