import { Injectable } from '@nestjs/common';
import type { Application, JobPosting, Prisma } from '@hrm/db';
import type { ApplyToPostingInput } from '@hrm/shared';
import { ApplicationService } from '../applications/application.service';
import { ScreeningService } from '../screening/screening.service';
import { ResumeParsingService, StoredResumeFile } from '../resume-parsing/resume-parsing.service';
import { CandidateService } from './candidate.service';

/**
 * The ONE "a candidate applies to a posting" path, shared by the PUBLIC
 * careers apply route and the recruiter-facing "add applicant" route — so a
 * resume is stored, parse-queued and (later) scored identically whichever
 * door it came through. Lifted out of `CareersService.apply` unchanged in
 * behaviour except for ordering: the duplicate-apply 409 now happens BEFORE
 * the resume upload, so a rejected duplicate no longer leaves an orphan
 * object in storage.
 */
@Injectable()
export class CandidateIntakeService {
  constructor(
    private readonly candidates: CandidateService,
    private readonly applications: ApplicationService,
    private readonly resumeParsing: ResumeParsingService,
    private readonly screening: ScreeningService,
  ) {}

  async intake(
    tx: Prisma.TransactionClient,
    tenantId: string,
    posting: JobPosting,
    input: ApplyToPostingInput,
    source: string,
    resume?: StoredResumeFile,
  ): Promise<Application> {
    const candidate = await this.candidates.upsertByEmail(tx, tenantId, { ...input, source });
    const application = await this.applications.apply(tx, tenantId, posting.id, candidate.id);
    if (resume) {
      await this.resumeParsing.storeAndEnqueue(tx, tenantId, candidate.id, resume);
    } else {
      // A returning candidate may already have parsed data — score this new application against it.
      await this.screening.rescoreForCandidate(tx, candidate.id);
    }
    return application;
  }
}
