import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { JobPosting, Prisma } from '@hrm/db';
import type { CreateJobPostingInput } from '@hrm/shared';
import { MAX_LIST_RESULTS } from '../recruitment.constants';

/**
 * Job postings — the PUBLIC-facing side of an APPROVED requisition. See
 * docs/conventions/recruitment-lifecycle.md. Internal CRUD lives here;
 * `CareersService` (this module's public read/apply surface) reads the
 * SAME `JobPosting` table filtered to `status: 'PUBLISHED'`, never a
 * separate public-facing copy.
 */
@Injectable()
export class JobPostingService {
  async create(tx: Prisma.TransactionClient, tenantId: string, input: CreateJobPostingInput): Promise<JobPosting> {
    const requisition = await tx.jobRequisition.findUnique({ where: { id: input.requisitionId } });
    if (!requisition) {
      throw new NotFoundException(`Job requisition "${input.requisitionId}" was not found.`);
    }
    if (requisition.status !== 'APPROVED') {
      throw new ConflictException(`Job requisition "${input.requisitionId}" must be APPROVED before a posting can be created from it.`);
    }

    return tx.jobPosting.create({
      data: {
        tenantId,
        requisitionId: input.requisitionId,
        title: input.title,
        description: input.description,
        publicSlug: input.publicSlug,
      },
    });
  }

  async publish(tx: Prisma.TransactionClient, id: string): Promise<JobPosting> {
    const posting = await this.requirePosting(tx, id);
    if (posting.status !== 'DRAFT') {
      throw new ConflictException(`Job posting "${id}" is "${posting.status}" and cannot be published.`);
    }
    return tx.jobPosting.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  }

  async close(tx: Prisma.TransactionClient, id: string): Promise<JobPosting> {
    const posting = await this.requirePosting(tx, id);
    if (posting.status !== 'PUBLISHED') {
      throw new ConflictException(`Job posting "${id}" is "${posting.status}" and cannot be closed.`);
    }
    return tx.jobPosting.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
  }

  async list(tx: Prisma.TransactionClient, status?: string): Promise<JobPosting[]> {
    return tx.jobPosting.findMany({
      where: status ? { status: status as JobPosting['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST_RESULTS,
    });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<JobPosting> {
    return this.requirePosting(tx, id);
  }

  async requirePosting(tx: Prisma.TransactionClient, id: string): Promise<JobPosting> {
    const posting = await tx.jobPosting.findUnique({ where: { id } });
    if (!posting) {
      throw new NotFoundException(`Job posting "${id}" was not found.`);
    }
    return posting;
  }
}
