import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RESUME_PARSE_QUEUE } from '../queue/queue.constants';
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
import { CandidateIntakeService } from './candidates/candidate-intake.service';
import { ScreeningController } from './screening/screening.controller';
import { ScreeningService } from './screening/screening.service';
import { ResumeParsingService } from './resume-parsing/resume-parsing.service';
import { ResumeParseProcessor } from './resume-parsing/resume-parse.processor';
import { RESUME_PARSER } from './resume-parsing/resume-parser.interface';
import { BuiltInResumeParser } from './resume-parsing/built-in-resume-parser';
import { UnavailableResumeParser } from './resume-parsing/unavailable-resume-parser';

/**
 * `RESUME_PARSER_PROVIDER` selects the bound parser — see
 * docs/conventions/resume-parsing-screening.md → How to swap in a better
 * parser. Unset / `builtin` → the dependency-free heuristic parser. Any other
 * value is a documented seam that fails loudly until a real adapter is bound
 * here (never a silent fallback).
 */
function createResumeParser() {
  const provider = (process.env.RESUME_PARSER_PROVIDER ?? 'builtin').trim().toLowerCase();
  return provider === 'builtin' || provider === '' ? new BuiltInResumeParser() : new UnavailableResumeParser(provider);
}

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
  imports: [
    WorkflowModule,
    BullModule.registerQueue({
      name: RESUME_PARSE_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [RecruitmentController, CareersController, ScreeningController],
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
    CandidateIntakeService,
    ScreeningService,
    ResumeParsingService,
    ResumeParseProcessor,
    { provide: RESUME_PARSER, useFactory: createResumeParser },
  ],
  exports: [CandidateService, ApplicationService, OfferService],
})
export class RecruitmentModule {}
