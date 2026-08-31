import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { RecruitmentController } from './recruitment.controller';
import { CareersController } from './careers/careers.controller';
import { CareersService } from './careers/careers.service';
import { JobRequisitionService } from './requisitions/job-requisition.service';
import { JobRequisitionWorkflowEventsListener } from './requisitions/job-requisition-workflow-events.listener';
import { JobPostingService } from './postings/job-posting.service';
import { CandidateService } from './candidates/candidate.service';
import { ApplicationService } from './applications/application.service';
import { InterviewService } from './interviews/interview.service';
import { OfferService } from './offers/offer.service';
import { OfferWorkflowEventsListener } from './offers/offer-workflow-events.listener';

/**
 * The Recruitment (ATS) module (step 2.3) — see
 * docs/conventions/recruitment-lifecycle.md. Imports `WorkflowModule` to
 * inject `WorkflowEngineService` directly (a requisition/offer approval
 * just starts a `WorkflowInstance` — THE RULE), the SAME reuse every
 * workflow-consuming module already establishes. `StorageService`/
 * `TenantContextService` need no explicit import — both `@Global()`.
 * `CandidateService`/`ApplicationService` are exported so `OnboardingModule`
 * can inject them directly (an accepted offer's onboarding process needs
 * the candidate's identity data — see `OnboardingService`).
 */
@Module({
  imports: [WorkflowModule],
  controllers: [RecruitmentController, CareersController],
  providers: [
    JobRequisitionService,
    JobRequisitionWorkflowEventsListener,
    JobPostingService,
    CandidateService,
    ApplicationService,
    InterviewService,
    OfferService,
    OfferWorkflowEventsListener,
    CareersService,
  ],
  exports: [CandidateService, ApplicationService, OfferService],
})
export class RecruitmentModule {}
