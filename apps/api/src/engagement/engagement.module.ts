import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ENGAGEMENT_CELEBRATIONS_QUEUE } from '../queue/queue.constants';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CelebrationsProcessor } from './celebrations.processor';
import { CelebrationsService } from './celebrations.service';
import { EngagementController } from './engagement.controller';
import { EngagementOverviewService } from './engagement-overview.service';
import { FeedService } from './feed.service';
import { RecognitionCategoryService } from './recognition-category.service';
import { RecognitionService } from './recognition.service';
import { SurveyAudienceService } from './survey-audience.service';
import { SurveyResponseService } from './survey-response.service';
import { SurveyResultsService } from './survey-results.service';
import { SurveyService } from './survey.service';

/**
 * Engagement & culture (step 10.1): recognition, surveys, the company feed — see
 * docs/conventions/engagement-culture.md. A CONSUMER of existing systems, none of which changed
 * beyond one additive export: tenancy/RLS (`TenantContextService`), RBAC (`PermissionsGuard`),
 * audit (`AuditInterceptor`), the 0.8 notification hub (via `EventEmitter2`), the 1.5/3.2 scheduled-
 * job pattern (BullMQ queue + `WorkerHost`), and 8.2's `SchedulingScopeService` (a manager's
 * reporting chain = a survey "team").
 */
@Module({
  imports: [
    SchedulingModule,
    BullModule.registerQueue({
      name: ENGAGEMENT_CELEBRATIONS_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [EngagementController],
  providers: [
    RecognitionCategoryService,
    RecognitionService,
    SurveyAudienceService,
    SurveyService,
    SurveyResponseService,
    SurveyResultsService,
    FeedService,
    CelebrationsService,
    CelebrationsProcessor,
    EngagementOverviewService,
  ],
})
export class EngagementModule {}
