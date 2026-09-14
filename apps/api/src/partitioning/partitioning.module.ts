import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StorageModule } from '../storage/storage.module';
import { PARTITION_ARCHIVAL_QUEUE, PARTITION_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { PartitionMaintenanceService } from './partition-maintenance.service';
import { PartitionMaintenanceProcessor } from './partition-maintenance.processor';
import { PartitionArchivalService } from './partition-archival.service';
import { PartitionArchivalProcessor } from './partition-archival.processor';
import { PartitionStatusService } from './partition-status.service';
import { PartitionRetentionService } from './partition-retention.service';

/**
 * Table partitioning + archival (step 5.2, Phase 5) — see
 * docs/conventions/partitioning-archival.md. Turns Phase 0.9/1.3's
 * PARTITION-READY `attendance_records`/`audit_log` (plus 4.1's
 * `platform_audit_log`) into REAL Postgres `PARTITION BY RANGE` tables (the
 * actual conversion lives entirely in `packages/db`'s
 * `partition_high_growth_tables` migration — this module owns only the
 * ONGOING management: automated partition creation ahead of time, and
 * age-based archival to object storage).
 *
 * No controller here — `PlatformModule`'s own `partitioning/` sub-module is
 * the HTTP surface (this is cross-tenant infra, the same "platform owns the
 * route, imports the real module's services" shape `BillingModule`/
 * `BrandingModule`/`MigrationModule` already establish for `PlatformModule`
 * — see that module's own doc comment).
 */
@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue(
      { name: PARTITION_MAINTENANCE_QUEUE, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } } },
      { name: PARTITION_ARCHIVAL_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } } },
    ),
  ],
  providers: [
    PartitionMaintenanceService,
    PartitionMaintenanceProcessor,
    PartitionArchivalService,
    PartitionArchivalProcessor,
    PartitionStatusService,
    PartitionRetentionService,
  ],
  exports: [PartitionMaintenanceService, PartitionArchivalService, PartitionStatusService, PartitionRetentionService],
})
export class PartitioningModule {}
