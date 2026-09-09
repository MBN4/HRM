import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { OfferService } from '../../recruitment/offers/offer.service';
import { PolicyService } from '../../announcements/policy.service';
import { OFFER_ENTITY_TYPE, POLICY_ENTITY_TYPE } from '../esignature.constants';

interface EsignatureCompletedPayload {
  tenantId: string;
  requestId: string;
  entityType: string | null;
  entityId: string | null;
  createdByUserId: string;
}

/**
 * "When a SignatureRequest completes, apply the ONE side effect the
 * generic e-signature module has no way to know about" — the identical
 * shape `OfferWorkflowEventsListener`/`OnboardingOfferAcceptedListener`
 * already establish for their own domain-event reactions (see
 * docs/conventions/recruitment-lifecycle.md). Reacts to
 * `esignature.completed` — never a direct call from `SigningProgressService`
 * into `OfferService`/`PolicyService`, keeping the e-signature module a
 * genuinely generic, entity-agnostic mechanism (it emits one event; it does
 * not know or care who's listening).
 *
 * - `entityType === 'Offer'`: calls the REAL, UNMODIFIED
 *   `OfferService.accept` — which already emits `recruitment.offer_accepted`,
 *   already picked up by the EXISTING `OnboardingOfferAcceptedListener`
 *   (2.3, untouched) — so a signed offer flows into onboarding with ZERO
 *   changes to Recruitment/Onboarding beyond this one new listener. Guarded
 *   by `OfferService.accept`'s own pre-existing `status !== 'APPROVED'`
 *   check: if the offer was ALSO accepted directly via
 *   `POST /recruitment/offers/:id/accept` (e.g. an admin recording a
 *   verbal acceptance) before this listener runs, this call simply throws
 *   a (caught, logged) `ConflictException` — no double-accept, no
 *   duplicate `OnboardingProcess`, regardless of which path fires first.
 * - `entityType === 'Policy'`: resolves the (single, internal) signer on
 *   the completed request and calls `PolicyService.acknowledge(...,
 *   bypassSignatureRequirement: true)` — the SAME real method the ordinary
 *   click-to-acknowledge route calls, so admin tracking sees an identical
 *   `PolicyAcknowledgment` row either way, on top of the full signing
 *   trail this module additionally recorded.
 */
@Injectable()
export class EsignatureCompletionSideEffectsListener {
  private readonly logger = new Logger(EsignatureCompletionSideEffectsListener.name);

  constructor(
    private readonly offers: OfferService,
    private readonly policies: PolicyService,
  ) {}

  @OnEvent('esignature.completed')
  handleCompleted(payload: EsignatureCompletedPayload): void {
    this.handle(payload).catch((error: unknown) => {
      this.logger.error(`Failed to apply completion side effect for signature request "${payload.requestId}": ${String(error)}`);
    });
  }

  private async handle(payload: EsignatureCompletedPayload): Promise<void> {
    if (payload.entityType === OFFER_ENTITY_TYPE && payload.entityId) {
      await withTenantContext(payload.tenantId, (tx: Prisma.TransactionClient) => this.offers.accept(tx, payload.tenantId, payload.entityId!));
      return;
    }
    if (payload.entityType === POLICY_ENTITY_TYPE && payload.entityId) {
      await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
        const signer = await tx.signatureSigner.findFirst({
          where: { tenantId: payload.tenantId, signatureRequestId: payload.requestId, signerType: 'INTERNAL' },
        });
        if (!signer?.userId) {
          this.logger.warn(`Policy signature request "${payload.requestId}" completed with no internal signer to acknowledge as.`);
          return;
        }
        await this.policies.acknowledge(tx, payload.tenantId, payload.entityId!, signer.userId, true);
      });
    }
  }
}
