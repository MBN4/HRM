import { Injectable, NotFoundException } from '@nestjs/common';
import type { Candidate, Prisma } from '@hrm/db';
import { MAX_LIST_RESULTS } from '../recruitment.constants';

export interface UpsertCandidateInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  source?: string;
}

/**
 * A candidate's IDENTITY, deduplicated per tenant by email — see
 * docs/conventions/recruitment-lifecycle.md. `upsertByEmail` is the ONE
 * write path (used by both the public "apply" flow and any future
 * internal candidate-entry route) so re-applying with an updated resume
 * always lands on the SAME row rather than creating a duplicate identity.
 */
@Injectable()
export class CandidateService {
  async upsertByEmail(tx: Prisma.TransactionClient, tenantId: string, input: UpsertCandidateInput): Promise<Candidate> {
    return tx.candidate.upsert({
      where: { tenantId_email: { tenantId, email: input.email } },
      update: { firstName: input.firstName, lastName: input.lastName, phone: input.phone ?? null },
      create: {
        tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone ?? null,
        source: input.source ?? null,
      },
    });
  }

  async setResumeStorageKey(tx: Prisma.TransactionClient, candidateId: string, resumeStorageKey: string): Promise<void> {
    await tx.candidate.update({ where: { id: candidateId }, data: { resumeStorageKey } });
  }

  async list(tx: Prisma.TransactionClient): Promise<Candidate[]> {
    return tx.candidate.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_LIST_RESULTS });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<Candidate> {
    const candidate = await tx.candidate.findUnique({ where: { id } });
    if (!candidate) {
      throw new NotFoundException(`Candidate "${id}" was not found.`);
    }
    return candidate;
  }
}
