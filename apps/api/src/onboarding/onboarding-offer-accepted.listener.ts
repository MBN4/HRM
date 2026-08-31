import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { OnboardingService } from './onboarding.service';

interface OfferAcceptedPayload {
  tenantId: string;
  offerId: string;
  applicationId: string;
  candidateId: string;
}

/**
 * "When an offer is ACCEPTED, an onboarding process starts" — see
 * docs/conventions/recruitment-lifecycle.md. Reacts to
 * `recruitment.offer_accepted` (`OfferService.accept`) — never a direct
 * Recruitment -> Onboarding service call, the SAME fire-and-forget
 * event-listener shape every cross-module reaction in this codebase
 * already uses (`PayrollWorkflowEventsListener`, `LeaveWorkflowEventsListener`,
 * ...). `OnboardingService.start` is itself idempotent against a
 * redelivered event.
 */
@Injectable()
export class OnboardingOfferAcceptedListener {
  private readonly logger = new Logger(OnboardingOfferAcceptedListener.name);

  constructor(private readonly onboarding: OnboardingService) {}

  @OnEvent('recruitment.offer_accepted')
  handleOfferAccepted(payload: OfferAcceptedPayload): void {
    this.handle(payload).catch((error: unknown) => {
      this.logger.error(`Failed to start onboarding for offer "${payload.offerId}": ${String(error)}`);
    });
  }

  private async handle(payload: OfferAcceptedPayload): Promise<void> {
    await withTenantContext(payload.tenantId, (tx: Prisma.TransactionClient) =>
      this.onboarding.start(tx, payload.tenantId, payload.offerId, payload.candidateId),
    );
  }
}
