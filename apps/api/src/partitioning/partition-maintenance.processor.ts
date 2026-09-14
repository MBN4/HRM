import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PARTITION_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { PartitionMaintenanceService } from './partition-maintenance.service';

/** Worker side — see PartitionMaintenanceService's doc comment. */
@Processor(PARTITION_MAINTENANCE_QUEUE)
export class PartitionMaintenanceProcessor extends WorkerHost {
  constructor(private readonly maintenance: PartitionMaintenanceService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.maintenance.ensureAllPartitions();
  }
}
