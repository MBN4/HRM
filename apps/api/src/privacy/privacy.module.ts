import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { PRIVACY_QUEUE } from '../queue/queue.constants';
import { PrivacyController } from './privacy.controller';
import { DataSubjectRequestService } from './data-subject-request.service';
import { DataExportService } from './data-export.service';
import { PrivacyErasureService } from './privacy-erasure.service';
import { PrivacyProcessor } from './privacy.processor';
import { ConsentService } from './consent.service';
import { ProcessingRegisterService } from './processing-register.service';
import { RetentionEnforcementService } from './retention-enforcement.service';

/**
 * Data privacy & residency (step 6.1) — see
 * docs/conventions/privacy-residency.md. A thin consumer of `AuthModule`
 * (`TokenService`, for the erasure engine's access-revocation hand-off —
 * the SAME primitive offboarding.md already reuses), `StorageModule`/
 * `EncryptionModule` (both `@Global()`, no import needed), and the reusable
 * BullMQ `QueueModule` pattern every prior module already establishes.
 * `DataSubjectRequestService`/`PrivacyErasureService`/
 * `ProcessingRegisterService` are exported so `PlatformPrivacyModule` (the
 * vendor console's cross-tenant oversight surface) reuses the SAME engines,
 * never a parallel implementation — the identical direction
 * `MigrationModule`/`PartitioningModule` already establish for their own
 * platform counterparts.
 */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({
      name: PRIVACY_QUEUE,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    }),
  ],
  controllers: [PrivacyController],
  providers: [
    DataSubjectRequestService,
    DataExportService,
    PrivacyErasureService,
    PrivacyProcessor,
    ConsentService,
    ProcessingRegisterService,
    RetentionEnforcementService,
  ],
  exports: [DataSubjectRequestService, PrivacyErasureService, ProcessingRegisterService, RetentionEnforcementService],
})
export class PrivacyModule {}
