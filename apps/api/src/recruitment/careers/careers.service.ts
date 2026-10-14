import { Injectable, NotFoundException } from '@nestjs/common';
import type { Application, JobPosting, Prisma } from '@hrm/db';
import type { ApplyToPostingInput } from '@hrm/shared';
import { CandidateIntakeService } from '../candidates/candidate-intake.service';
import { MAX_LIST_RESULTS } from '../recruitment.constants';

/** What the public apply route returns — an `Application` without any recruiter-only screening output. */
export type PublicApplication = Omit<Application, 'screeningScore' | 'screeningResult' | 'belowThreshold' | 'screenedAt'>;

export interface ApplyResumeFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * The PUBLIC careers API's read/apply logic — see
 * docs/conventions/recruitment-lifecycle.md → The public careers API.
 * Reads/writes exactly the SAME `JobPosting`/`Candidate`/`Application`
 * tables the internal recruitment module owns — there is no separate
 * public-facing copy of this data. Only ever touches `status: 'PUBLISHED'`
 * postings; a `DRAFT`/`CLOSED` posting's slug resolves to a `404`, the
 * same "non-disclosure via 404" posture 0.8's notification mark-read route
 * already holds itself to.
 */
@Injectable()
export class CareersService {
  constructor(private readonly intake: CandidateIntakeService) {}

  async listPublished(tx: Prisma.TransactionClient): Promise<JobPosting[]> {
    return tx.jobPosting.findMany({ where: { status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  async getPublishedBySlug(tx: Prisma.TransactionClient, slug: string): Promise<JobPosting> {
    const posting = await tx.jobPosting.findFirst({ where: { publicSlug: slug, status: 'PUBLISHED' } });
    if (!posting) {
      throw new NotFoundException(`No published job posting exists at "${slug}".`);
    }
    return posting;
  }

  async apply(
    tx: Prisma.TransactionClient,
    tenantId: string,
    slug: string,
    input: ApplyToPostingInput,
    resume?: ApplyResumeFile,
  ): Promise<PublicApplication> {
    const posting = await this.getPublishedBySlug(tx, slug);
    const application = await this.intake.intake(tx, tenantId, posting, input, 'careers_page', resume);
    // Screening output is recruiter-only: this route is unauthenticated, so an applicant
    // must never be handed their own (or a returning applicant's) score/breakdown.
    const { screeningScore: _s, screeningResult: _r, belowThreshold: _b, screenedAt: _t, ...publicView } = application;
    return publicView;
  }
}
