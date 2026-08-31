import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Interview, InterviewScorecard, Prisma } from '@hrm/db';
import type { CreateInterviewInput, SubmitScorecardInput } from '@hrm/shared';

/** Interview scheduling + scorecards — see docs/conventions/recruitment-lifecycle.md. */
@Injectable()
export class InterviewService {
  async schedule(tx: Prisma.TransactionClient, tenantId: string, input: CreateInterviewInput): Promise<Interview> {
    await this.requireApplication(tx, input.applicationId);
    return tx.interview.create({
      data: {
        tenantId,
        applicationId: input.applicationId,
        scheduledAt: input.scheduledAt,
        durationMinutes: input.durationMinutes,
        interviewerUserIds: input.interviewerUserIds as Prisma.InputJsonValue,
        location: input.location ?? null,
      },
    });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<Interview> {
    return this.requireInterview(tx, id);
  }

  async listForApplication(tx: Prisma.TransactionClient, applicationId: string): Promise<Interview[]> {
    return tx.interview.findMany({ where: { applicationId }, orderBy: { scheduledAt: 'asc' } });
  }

  /**
   * Gated at the ROW level (must be on the interview's own panel), not just
   * `recruitment.write` — a `recruitment.manage` holder may submit on
   * behalf of the panel (e.g. recording a verbal scorecard for someone who
   * didn't use the system), the SAME "permission gates the feature, an
   * explicit manage-tier override widens who may act" shape this whole
   * codebase already uses (e.g. Leave's `leave.approve`).
   */
  async submitScorecard(
    tx: Prisma.TransactionClient,
    tenantId: string,
    interviewId: string,
    callerUserId: string,
    canManage: boolean,
    input: SubmitScorecardInput,
  ): Promise<InterviewScorecard> {
    const interview = await this.requireInterview(tx, interviewId);
    const panel = interview.interviewerUserIds as string[];
    if (!panel.includes(callerUserId) && !canManage) {
      throw new ForbiddenException('You are not on this interview panel.');
    }

    const existing = await tx.interviewScorecard.findUnique({
      where: { tenantId_interviewId_interviewerUserId: { tenantId, interviewId, interviewerUserId: callerUserId } },
    });
    if (existing) {
      throw new ConflictException('You have already submitted a scorecard for this interview.');
    }

    return tx.interviewScorecard.create({
      data: {
        tenantId,
        interviewId,
        interviewerUserId: callerUserId,
        rating: input.rating,
        recommendation: input.recommendation,
        notes: input.notes ?? null,
      },
    });
  }

  async listScorecards(tx: Prisma.TransactionClient, interviewId: string): Promise<InterviewScorecard[]> {
    return tx.interviewScorecard.findMany({ where: { interviewId }, orderBy: { submittedAt: 'asc' } });
  }

  private async requireApplication(tx: Prisma.TransactionClient, applicationId: string): Promise<void> {
    const application = await tx.application.findUnique({ where: { id: applicationId }, select: { id: true } });
    if (!application) {
      throw new NotFoundException(`Application "${applicationId}" was not found.`);
    }
  }

  private async requireInterview(tx: Prisma.TransactionClient, id: string): Promise<Interview> {
    const interview = await tx.interview.findUnique({ where: { id } });
    if (!interview) {
      throw new NotFoundException(`Interview "${id}" was not found.`);
    }
    return interview;
  }
}
