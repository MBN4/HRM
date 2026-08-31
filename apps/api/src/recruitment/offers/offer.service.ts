import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Offer, Prisma } from '@hrm/db';
import type { CreateOfferInput } from '@hrm/shared';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import { OFFER_ENTITY_TYPE, MAX_LIST_RESULTS } from '../recruitment.constants';

/**
 * Offers — see docs/conventions/recruitment-lifecycle.md. Owns NO
 * approve/reject logic of its own (THE RULE): `submitForApproval` starts a
 * real 0.7 `WorkflowInstance`; `OfferWorkflowEventsListener` reacts to the
 * decision. `accept` is the ONE action this whole step's lifecycle hinges
 * on — it emits `recruitment.offer_accepted`, picked up by an
 * Onboarding-owned listener that starts the candidate -> Employee bridge
 * (never a direct service call between the two modules — the same
 * fire-and-forget event shape every cross-module reaction in this codebase
 * already uses).
 */
@Injectable()
export class OfferService {
  constructor(
    private readonly workflowEngine: WorkflowEngineService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, input: CreateOfferInput): Promise<Offer> {
    const application = await tx.application.findUnique({ where: { id: input.applicationId } });
    if (!application) {
      throw new NotFoundException(`Application "${input.applicationId}" was not found.`);
    }
    const existing = await tx.offer.findUnique({ where: { tenantId_applicationId: { tenantId, applicationId: input.applicationId } } });
    if (existing) {
      throw new ConflictException(`Application "${input.applicationId}" already has an offer.`);
    }

    return tx.offer.create({
      data: {
        tenantId,
        applicationId: input.applicationId,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        employmentType: input.employmentType,
        proposedSalary: input.proposedSalary,
        salaryCurrency: input.salaryCurrency,
        proposedJoinDate: input.proposedJoinDate,
        createdByUserId: callerUserId,
      },
    });
  }

  async submitForApproval(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, id: string): Promise<void> {
    const offer = await this.requireOffer(tx, id);
    if (offer.status !== 'DRAFT') {
      throw new ConflictException(`Offer "${id}" is "${offer.status}" and can no longer be submitted for approval.`);
    }

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: callerUserId,
      entityType: OFFER_ENTITY_TYPE,
      entityId: offer.id,
      dataSnapshot: {
        applicationId: offer.applicationId,
        branchId: offer.branchId,
        proposedSalary: offer.proposedSalary.toString(),
        salaryCurrency: offer.salaryCurrency,
      },
    });

    await tx.offer.update({ where: { id }, data: { status: 'PENDING_APPROVAL', workflowInstanceId: instance.id } });
  }

  async accept(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Offer> {
    const offer = await this.requireOffer(tx, id);
    if (offer.status !== 'APPROVED') {
      throw new ConflictException(`Offer "${id}" must be APPROVED before it can be accepted (is "${offer.status}").`);
    }

    const updated = await tx.offer.update({ where: { id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
    const application = await tx.application.update({ where: { id: offer.applicationId }, data: { stage: 'HIRED' } });

    this.eventEmitter.emit('recruitment.offer_accepted', {
      type: 'recruitment.offer_accepted',
      tenantId,
      offerId: updated.id,
      applicationId: application.id,
      candidateId: application.candidateId,
    });

    return updated;
  }

  async decline(tx: Prisma.TransactionClient, id: string): Promise<Offer> {
    const offer = await this.requireOffer(tx, id);
    if (offer.status !== 'APPROVED') {
      throw new ConflictException(`Offer "${id}" must be APPROVED before it can be declined (is "${offer.status}").`);
    }
    await tx.application.update({ where: { id: offer.applicationId }, data: { stage: 'REJECTED' } });
    return tx.offer.update({ where: { id }, data: { status: 'DECLINED', declinedAt: new Date() } });
  }

  async list(tx: Prisma.TransactionClient, applicationId?: string): Promise<Offer[]> {
    return tx.offer.findMany({
      where: applicationId ? { applicationId } : {},
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST_RESULTS,
    });
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<Offer> {
    return this.requireOffer(tx, id);
  }

  async requireOffer(tx: Prisma.TransactionClient, id: string): Promise<Offer> {
    const offer = await tx.offer.findUnique({ where: { id } });
    if (!offer) {
      throw new NotFoundException(`Offer "${id}" was not found.`);
    }
    return offer;
  }
}
