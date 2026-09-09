import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, SignatureEventType } from '@hrm/db';
import { StorageService } from '../storage/storage.service';
import { SigningTokenService } from './signing-token.service';
import { ExternalSignerNotifierService } from './external-signer-notifier.service';
import { SignatureCertificatePdfService } from './signature-certificate-pdf.service';
import { DEFAULT_SIGNING_LINK_EXPIRY_DAYS } from './esignature.constants';

interface RecordEventParams {
  signerId?: string | null;
  actorUserId?: string | null;
  actorExternalName?: string | null;
  actorExternalEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  signingMethod?: 'TYPED_NAME' | 'DRAWN_SIGNATURE' | 'CLICK_TO_SIGN' | null;
  documentHash?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * THE SEQUENCING / STATE-MACHINE ENGINE — deliberately its own small
 * mechanism, NOT the 0.7 workflow engine, mirroring exactly the reasoning
 * checklists.md already documents for its own mini-engine relative to
 * `ApproverRule`: signing is an ACTION (sign/decline), never a multi-step
 * approve/reject/delegate/escalate DECISION, so reusing the whole workflow
 * engine here would be reuse in name only. `SignatureSigner.order` mirrors
 * `WorkflowStep.order`'s OWN "shares a value = parallel group, differs =
 * sequential" shape, just re-implemented at this module's much smaller
 * scale. A genuine multi-party APPROVAL need is a separate, optional real
 * `WorkflowInstance` a consuming module may start on its own — this module
 * has no opinion on that.
 *
 * `advance()` is the ONE place that decides "what's next", called both from
 * `SignatureRequestService.send()` (activates the very first group) and
 * after every signer action (`SigningService`) — the same
 * "one function owns the whole state machine" posture
 * `WorkflowEngineService.activateNextGroup` already establishes.
 */
@Injectable()
export class SigningProgressService {
  constructor(
    private readonly tokens: SigningTokenService,
    private readonly externalNotifier: ExternalSignerNotifierService,
    private readonly certificatePdf: SignatureCertificatePdfService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  async recordEvent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    signatureRequestId: string,
    eventType: SignatureEventType,
    params: RecordEventParams = {},
  ): Promise<void> {
    await tx.signatureEvent.create({
      data: {
        tenantId,
        signatureRequestId,
        signerId: params.signerId ?? null,
        eventType,
        actorUserId: params.actorUserId ?? null,
        actorExternalName: params.actorExternalName ?? null,
        actorExternalEmail: params.actorExternalEmail ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        signingMethod: params.signingMethod ?? null,
        documentHash: params.documentHash ?? null,
        metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });
  }

  /** Advances (or completes) a request's signing progress — see the class doc comment. Safe to call repeatedly: a request already in a terminal status is a no-op, and a group already activated is never re-activated. */
  async advance(tx: Prisma.TransactionClient, tenantId: string, requestId: string): Promise<void> {
    const request = await tx.signatureRequest.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: requestId } },
      include: { signers: { orderBy: { order: 'asc' } } },
    });

    if (request.status === 'DECLINED' || request.status === 'CANCELED' || request.status === 'COMPLETED') {
      return;
    }

    if (request.signers.some((signer) => signer.status === 'DECLINED')) {
      await tx.signatureRequest.update({ where: { id: requestId }, data: { status: 'DECLINED' } });
      return;
    }

    const orders = [...new Set(request.signers.map((signer) => signer.order))].sort((a, b) => a - b);
    for (const order of orders) {
      const group = request.signers.filter((signer) => signer.order === order);
      if (group.every((signer) => signer.status === 'SIGNED')) {
        continue;
      }
      if (group.every((signer) => signer.status === 'PENDING')) {
        await this.activateGroup(tx, tenantId, request, group);
      }
      const anySigned = request.signers.some((signer) => signer.status === 'SIGNED');
      await tx.signatureRequest.update({
        where: { id: requestId },
        data: { status: anySigned ? 'PARTIALLY_SIGNED' : 'SENT' },
      });
      return;
    }

    await this.completeRequest(tx, tenantId, request.id, request.title, request.entityType, request.entityId, request.createdByUserId);
  }

  private async activateGroup(
    tx: Prisma.TransactionClient,
    tenantId: string,
    request: { id: string; title: string; expiresAt: Date | null },
    group: Array<{
      id: string;
      signerType: 'INTERNAL' | 'EXTERNAL';
      userId: string | null;
      externalName: string | null;
      externalEmail: string | null;
    }>,
  ): Promise<void> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });

    for (const signer of group) {
      const now = new Date();
      if (signer.signerType === 'INTERNAL') {
        await tx.signatureSigner.update({ where: { id: signer.id }, data: { status: 'SENT', sentAt: now } });
        await this.recordEvent(tx, tenantId, request.id, 'SENT', { signerId: signer.id, actorUserId: signer.userId });
        this.eventEmitter.emit('esignature.request_sent', {
          type: 'esignature.request_sent',
          tenantId,
          signerId: signer.id,
          signerUserId: signer.userId,
          requestId: request.id,
          requestTitle: request.title,
        });
      } else {
        const { rawToken, prefix, hash } = await this.tokens.generate();
        const expiresAt = request.expiresAt ?? new Date(now.getTime() + DEFAULT_SIGNING_LINK_EXPIRY_DAYS * 86_400_000);
        await tx.signatureSigner.update({
          where: { id: signer.id },
          data: {
            status: 'SENT',
            sentAt: now,
            accessTokenPrefix: prefix,
            accessTokenHash: hash,
            accessTokenExpiresAt: expiresAt,
          },
        });
        await this.recordEvent(tx, tenantId, request.id, 'SENT', {
          signerId: signer.id,
          actorExternalName: signer.externalName,
          actorExternalEmail: signer.externalEmail,
        });
        await this.externalNotifier.notifySigningLink({
          signerId: signer.id,
          to: signer.externalEmail!,
          requestTitle: request.title,
          signingUrl: this.buildSigningUrl(tenant.slug, rawToken),
        });
      }
    }
  }

  private buildSigningUrl(tenantSlug: string, rawToken: string): string {
    const base = this.config.get<string>('PORTAL_BASE_URL') ?? 'http://localhost:3000';
    return `${base}/esign/${rawToken}?tenant=${encodeURIComponent(tenantSlug)}`;
  }

  private async completeRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestId: string,
    requestTitle: string,
    entityType: string | null,
    entityId: string | null,
    createdByUserId: string,
  ): Promise<void> {
    const now = new Date();
    const request = await tx.signatureRequest.update({ where: { id: requestId }, data: { status: 'COMPLETED', completedAt: now } });

    const signers = await tx.signatureSigner.findMany({
      where: { tenantId, signatureRequestId: requestId },
      orderBy: { order: 'asc' },
    });

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });

    const certificateLines = await Promise.all(
      signers.map(async (signer) => {
        let displayName = signer.externalName;
        let displayEmail = signer.externalEmail;
        if (signer.signerType === 'INTERNAL' && signer.userId) {
          const user = await tx.user.findUnique({ where: { id: signer.userId }, select: { email: true } });
          const employee = await tx.employee.findFirst({ where: { userId: signer.userId }, select: { firstName: true, lastName: true } });
          displayName = employee ? `${employee.firstName} ${employee.lastName}` : (user?.email ?? 'unknown');
          displayEmail = user?.email ?? null;
        }
        return {
          displayName: displayName ?? 'unknown',
          displayEmail,
          signerType: signer.signerType,
          signingMethod: signer.signingMethod ?? 'unknown',
          signedAtUtc: signer.signedAt?.toISOString() ?? 'unknown',
          ipAddress: null as string | null,
          userAgent: null as string | null,
          documentHash: request.documentHash,
        };
      }),
    );

    // Backfill IP/user-agent from each signer's own SIGNED event — the
    // evidentiary source of truth — rather than duplicating it onto
    // `SignatureSigner` itself.
    const signedEvents = await tx.signatureEvent.findMany({
      where: { tenantId, signatureRequestId: requestId, eventType: 'SIGNED' },
    });
    for (let i = 0; i < signers.length; i += 1) {
      const event = signedEvents.find((e) => e.signerId === signers[i].id);
      if (event) {
        certificateLines[i].ipAddress = event.ipAddress;
        certificateLines[i].userAgent = event.userAgent;
        certificateLines[i].documentHash = event.documentHash ?? request.documentHash;
      }
    }

    const pdfBytes = await this.certificatePdf.render({
      tenantName: tenant.name,
      requestTitle,
      documentHash: request.documentHash,
      completedAtUtc: now.toISOString(),
      signers: certificateLines,
    });

    const storageKey = `esignatures/${tenantId}/${requestId}/certificate.pdf`;
    await this.storage.uploadObject({ key: storageKey, body: pdfBytes, contentType: 'application/pdf' });

    await tx.signatureCertificate.create({
      data: { tenantId, signatureRequestId: requestId, documentHash: request.documentHash, storageKey },
    });
    await this.recordEvent(tx, tenantId, requestId, 'CERTIFICATE_GENERATED', { documentHash: request.documentHash });

    this.eventEmitter.emit('esignature.completed', {
      type: 'esignature.completed',
      tenantId,
      requestId,
      entityType,
      entityId,
      createdByUserId,
    });
  }
}
