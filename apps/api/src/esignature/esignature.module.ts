import { Module } from '@nestjs/common';
import { RecruitmentModule } from '../recruitment/recruitment.module';
import { AnnouncementsModule } from '../announcements/announcements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SignatureRequestController } from './signature-request.controller';
import { ExternalSigningController } from './external-signing.controller';
import { SignatureRequestService } from './signature-request.service';
import { SigningService } from './signing.service';
import { SigningProgressService } from './signing-progress.service';
import { SigningTokenService } from './signing-token.service';
import { SignableDocumentPdfService } from './signable-document-pdf.service';
import { SignatureCertificatePdfService } from './signature-certificate-pdf.service';
import { ExternalSignerNotifierService } from './external-signer-notifier.service';
import { EsignatureCompletionSideEffectsListener } from './listeners/esignature-completion-side-effects.listener';

/**
 * The e-signature module (step 3.5.3) — see
 * docs/conventions/e-signatures.md. Imports `RecruitmentModule` (for the
 * REAL, unmodified `OfferService.accept`) and `AnnouncementsModule` (for
 * the REAL, unmodified-in-shape `PolicyService.acknowledge`) so its own
 * completion listener can apply the two integrations this step wires up —
 * the SAME "consuming module imports the reused one" direction every other
 * cross-module reuse in this codebase already takes (Expenses -> Payroll,
 * Onboarding -> Employees, ...). `StorageModule`/`HashingModule` are
 * `@Global()`, no explicit import needed. `NotificationsModule` is
 * imported for its additively-exported `EMAIL_PROVIDER` token (see
 * `ExternalSignerNotifierService`).
 */
@Module({
  imports: [RecruitmentModule, AnnouncementsModule, NotificationsModule],
  controllers: [SignatureRequestController, ExternalSigningController],
  providers: [
    SignatureRequestService,
    SigningService,
    SigningProgressService,
    SigningTokenService,
    SignableDocumentPdfService,
    SignatureCertificatePdfService,
    ExternalSignerNotifierService,
    EsignatureCompletionSideEffectsListener,
  ],
  exports: [SignatureRequestService],
})
export class EsignatureModule {}
