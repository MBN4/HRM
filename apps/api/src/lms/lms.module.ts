import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LMS_CERTIFICATION_EXPIRY_QUEUE, LMS_ROLLUP_QUEUE } from '../queue/queue.constants';
import { LmsController } from './lms.controller';
import { CourseCategoryService } from './course-category.service';
import { CourseService } from './course.service';
import { EnrollmentService } from './enrollment.service';
import { QuizService } from './quiz.service';
import { CertificationService } from './certification.service';
import { RequiredTrainingService } from './required-training.service';
import { LmsComplianceService } from './lms-compliance.service';
import { LmsAnalyticsService } from './lms-analytics.service';
import { CertificationExpiryService } from './certification-expiry.service';
import { CertificationExpiryProcessor } from './certification-expiry.processor';
import { LmsRollupService } from './rollup/lms-rollup.service';
import { LmsRollupProcessor } from './rollup/lms-rollup.processor';

/**
 * The Learning & Development (LMS) module (step 3.2) — see
 * docs/conventions/lms.md. A THIN module: content lives in 1.1's
 * StorageService/MinIO (`@Global()`, no explicit import needed), expiry
 * reminders reuse 0.8's notification hub (via `EventEmitter2`, no import
 * needed either) plus 0.10's scheduled-job BullMQ infra (the SAME pattern
 * 1.5's `AnalyticsModule` established), and completion/compliance
 * analytics follow the SAME precomputed-rollup discipline 1.5 established.
 * Registers TWO independent queues — course-completion/compliance rollup
 * and certification-expiry reminders — since they run on different
 * cadences and neither should block the other.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: LMS_ROLLUP_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
    BullModule.registerQueue({
      name: LMS_CERTIFICATION_EXPIRY_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [LmsController],
  providers: [
    CourseCategoryService,
    CourseService,
    EnrollmentService,
    QuizService,
    CertificationService,
    RequiredTrainingService,
    LmsComplianceService,
    LmsAnalyticsService,
    CertificationExpiryService,
    CertificationExpiryProcessor,
    LmsRollupService,
    LmsRollupProcessor,
  ],
})
export class LmsModule {}
