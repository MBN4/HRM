import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Application, Prisma } from '@hrm/db';
import { MAX_LIST_RESULTS } from '../recruitment.constants';

export interface ApplicationListFilters {
  jobPostingId?: string;
  candidateId?: string;
  stage?: string;
}

/**
 * A candidate's pipeline progress against one posting — see
 * docs/conventions/recruitment-lifecycle.md. Stage transitions carry NO
 * bespoke history table — `ApplicationController`'s `@AuditLog` on the
 * stage-change route, plus `AuditCaptureService.setBefore()`, already
 * gives a full before/after trail via the generic 0.9 audit log.
 */
@Injectable()
export class ApplicationService {
  /** Idempotent identity is `(tenantId, candidateId, jobPostingId)` — a duplicate apply is a 409, not a silent no-op, so a candidate gets clear feedback rather than wondering if their second submission registered. */
  async apply(tx: Prisma.TransactionClient, tenantId: string, jobPostingId: string, candidateId: string): Promise<Application> {
    const existing = await tx.application.findUnique({
      where: { tenantId_candidateId_jobPostingId: { tenantId, candidateId, jobPostingId } },
    });
    if (existing) {
      throw new ConflictException('You have already applied to this posting.');
    }
    return tx.application.create({ data: { tenantId, candidateId, jobPostingId } });
  }

  async updateStage(tx: Prisma.TransactionClient, id: string, stage: Application['stage']): Promise<Application> {
    await this.requireApplication(tx, id);
    return tx.application.update({ where: { id }, data: { stage } });
  }

  async list(tx: Prisma.TransactionClient, filters: ApplicationListFilters): Promise<Application[]> {
    const where: Prisma.ApplicationWhereInput = {};
    if (filters.jobPostingId) where.jobPostingId = filters.jobPostingId;
    if (filters.candidateId) where.candidateId = filters.candidateId;
    if (filters.stage) where.stage = filters.stage as Application['stage'];
    return tx.application.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<Application> {
    return this.requireApplication(tx, id);
  }

  async requireApplication(tx: Prisma.TransactionClient, id: string): Promise<Application> {
    const application = await tx.application.findUnique({ where: { id } });
    if (!application) {
      throw new NotFoundException(`Application "${id}" was not found.`);
    }
    return application;
  }
}
