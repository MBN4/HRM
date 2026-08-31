import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, Review, ReviewAssignment } from '@hrm/db';
import type { AssignPeerReviewersInput, SubmitReviewInput } from '@hrm/shared';
import { assertEligibleReviewType } from '../cycles/appraisal-cycle.service';

/**
 * Individual review submission — see docs/conventions/performance.md. Never
 * touches `Appraisal.status`/`overallRating` itself (that's
 * `AppraisalService.submitForApproval`'s job, once every assignment is
 * `SUBMITTED`) — this service's only job is the roster
 * (`ReviewAssignment`) and the submitted content (`Review`), one row each
 * per reviewer per appraisal.
 */
@Injectable()
export class ReviewService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  async assignPeers(tx: Prisma.TransactionClient, tenantId: string, appraisalId: string, input: AssignPeerReviewersInput): Promise<ReviewAssignment[]> {
    const appraisal = await tx.appraisal.findUnique({ where: { id: appraisalId }, include: { cycle: true } });
    if (!appraisal) {
      throw new NotFoundException(`Appraisal "${appraisalId}" was not found.`);
    }
    assertEligibleReviewType(appraisal.cycle.enabledReviewTypes, 'PEER');

    const created: ReviewAssignment[] = [];
    for (const reviewerId of input.reviewerIds) {
      const reviewer = await tx.employee.findUnique({ where: { id: reviewerId }, select: { id: true, userId: true } });
      if (!reviewer) {
        throw new BadRequestException(`Employee "${reviewerId}" was not found.`);
      }
      const row = await tx.reviewAssignment.create({
        data: { tenantId, appraisalId, reviewType: 'PEER', reviewerId },
      });
      created.push(row);
      // No linked `User` (e.g. a bulk-imported, not-yet-provisioned
      // employee) = no notification — a legitimate no-op, same posture
      // `AppraisalCycleService.emitReviewDue` takes for auto-resolved
      // assignments.
      if (reviewer.userId) {
        this.eventEmitter.emit('performance.review_due', {
          type: 'performance.review_due',
          tenantId,
          assignmentId: row.id,
          reviewerUserId: reviewer.userId,
        });
      }
    }
    return created;
  }

  async myAssignments(tx: Prisma.TransactionClient, callerUserId: string): Promise<ReviewAssignment[]> {
    const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
    if (!own) {
      return [];
    }
    return tx.reviewAssignment.findMany({
      where: { reviewerId: own.id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assignmentId: string,
    callerUserId: string,
    input: SubmitReviewInput,
  ): Promise<Review> {
    const assignment = await tx.reviewAssignment.findUnique({
      where: { id: assignmentId },
      include: { reviewer: true, appraisal: { include: { cycle: true } } },
    });
    if (!assignment) {
      throw new NotFoundException(`Review assignment "${assignmentId}" was not found.`);
    }
    if (assignment.reviewer.userId !== callerUserId) {
      throw new ForbiddenException('You may only submit a review you are assigned as the reviewer for.');
    }
    if (assignment.status !== 'PENDING') {
      throw new BadRequestException(`This review assignment is already "${assignment.status}".`);
    }

    const review = await tx.review.create({
      data: {
        tenantId,
        assignmentId,
        appraisalId: assignment.appraisalId,
        reviewType: assignment.reviewType,
        reviewerId: assignment.reviewerId,
        ratingScaleId: assignment.appraisal.cycle.ratingScaleId,
        overallRating: input.overallRating,
        strengths: input.strengths ?? null,
        improvements: input.improvements ?? null,
        comments: input.comments ?? null,
      },
    });
    await tx.reviewAssignment.update({ where: { id: assignmentId }, data: { status: 'SUBMITTED' } });
    return review;
  }
}
