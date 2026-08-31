import { Injectable, NotFoundException } from '@nestjs/common';
import type { Application, JobPosting, Prisma } from '@hrm/db';
import type { ApplyToPostingInput } from '@hrm/shared';
import { StorageService } from '../../storage/storage.service';
import { CandidateService } from '../candidates/candidate.service';
import { ApplicationService } from '../applications/application.service';
import { MAX_LIST_RESULTS } from '../recruitment.constants';

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
  constructor(
    private readonly storage: StorageService,
    private readonly candidates: CandidateService,
    private readonly applications: ApplicationService,
  ) {}

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
  ): Promise<Application> {
    const posting = await this.getPublishedBySlug(tx, slug);
    const candidate = await this.candidates.upsertByEmail(tx, tenantId, { ...input, source: 'careers_page' });

    if (resume) {
      const key = `candidates/${tenantId}/${candidate.id}/resume-${Date.now()}-${resume.originalname}`;
      await this.storage.uploadObject({ key, body: resume.buffer, contentType: resume.mimetype });
      await this.candidates.setResumeStorageKey(tx, candidate.id, key);
    }

    return this.applications.apply(tx, tenantId, posting.id, candidate.id);
  }
}
