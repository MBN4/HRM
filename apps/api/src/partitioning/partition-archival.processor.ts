import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PARTITION_ARCHIVAL_QUEUE } from '../queue/queue.constants';
import { PartitionArchivalService } from './partition-archival.service';

/** Worker side — see PartitionArchivalService's doc comment. */
@Processor(PARTITION_ARCHIVAL_QUEUE)
export class PartitionArchivalProcessor extends WorkerHost {
  constructor(private readonly archival: PartitionArchivalService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.archival.runArchivalSweep();
  }
}
