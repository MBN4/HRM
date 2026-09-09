import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, SignatureSigner } from '@hrm/db';
import type { SignDocumentInput } from '@hrm/shared';
import { StorageService } from '../storage/storage.service';
import { SigningTokenService } from './signing-token.service';
import { SigningProgressService } from './signing-progress.service';
import { sha256Hex } from './document-hash.util';

export interface SigningRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Per-SIGNER actions — view/sign/decline — for BOTH an internal (JWT'd)
 * caller and an external (token-scoped) one, which share the exact same
 * underlying state transitions and evidentiary-capture logic; only HOW the
 * caller is authorized to act on a given `SignatureSigner` differs (see
 * `resolveInternal`/`resolveExternal`). This is where the module's core
 * legal claim is implemented: every `sign()` call captures identity,
 * UTC timestamp, IP/user-agent, signing method, and a fresh SHA-256 of the
 * exact document bytes at that instant — written straight into the
 * append-only, DB-immutable `signature_events` table (see
 * docs/conventions/e-signatures.md and audit-custom-fields.md's own
 * `audit_log` immutability precedent, applied here).
 */
@Injectable()
export class SigningService {
  constructor(
    private readonly storage: StorageService,
    private readonly tokens: SigningTokenService,
    private readonly progress: SigningProgressService,
  ) {}

  /** Internal (ESS) — a signer the caller genuinely is, i.e. `signer.userId === callerUserId`. */
  async resolveInternal(tx: Prisma.TransactionClient, tenantId: string, signerId: string, callerUserId: string): Promise<SignatureSigner> {
    const signer = await tx.signatureSigner.findFirst({ where: { tenantId, id: signerId } });
    if (!signer || signer.signerType !== 'INTERNAL' || signer.userId !== callerUserId) {
      throw new NotFoundException(`No pending signature "${signerId}" was found for you.`);
    }
    return signer;
  }

  /** External (public link) — resolves and validates a raw token, WITHOUT authenticating anything beyond it (see docs/conventions/e-signatures.md → External signing links). */
  async resolveExternal(tx: Prisma.TransactionClient, tenantId: string, rawToken: string): Promise<SignatureSigner> {
    const prefix = this.tokens.extractPrefix(rawToken);
    if (!prefix) {
      throw new NotFoundException('Invalid signing link.');
    }
    const signer = await tx.signatureSigner.findUnique({ where: { tenantId_accessTokenPrefix: { tenantId, accessTokenPrefix: prefix } } });
    if (!signer || signer.signerType !== 'EXTERNAL' || !signer.accessTokenHash) {
      throw new NotFoundException('Invalid signing link.');
    }
    const matches = await this.tokens.verify(signer.accessTokenHash, rawToken);
    if (!matches) {
      throw new NotFoundException('Invalid signing link.');
    }
    if (signer.accessTokenExpiresAt && signer.accessTokenExpiresAt < new Date()) {
      throw new GoneException('This signing link has expired.');
    }
    return signer;
  }

  async view(tx: Prisma.TransactionClient, tenantId: string, signer: SignatureSigner): Promise<{ object: Awaited<ReturnType<StorageService['downloadObject']>>; mimeType: string; title: string }> {
    const request = await tx.signatureRequest.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: signer.signatureRequestId } } });
    if (signer.status === 'SENT') {
      await tx.signatureSigner.update({ where: { id: signer.id }, data: { status: 'VIEWED', viewedAt: new Date() } });
      await this.progress.recordEvent(tx, tenantId, request.id, 'VIEWED', {
        signerId: signer.id,
        actorUserId: signer.userId,
        actorExternalName: signer.externalName,
        actorExternalEmail: signer.externalEmail,
      });
    }
    const object = await this.storage.downloadObject(request.documentStorageKey);
    return { object, mimeType: request.documentMimeType, title: request.title };
  }

  async sign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    signer: SignatureSigner,
    input: SignDocumentInput,
    meta: SigningRequestMeta,
  ): Promise<SignatureSigner> {
    this.assertSignable(signer);
    const request = await tx.signatureRequest.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: signer.signatureRequestId } } });

    // The core evidentiary hash — the EXACT bytes currently at the
    // document's storage key, re-hashed at the moment of signing (never
    // just copied from `request.documentHash`) so a mismatch here would
    // itself be tamper-evidence.
    const object = await this.storage.downloadObject(request.documentStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      chunks.push(chunk as Buffer);
    }
    const documentHashAtSigning = sha256Hex(Buffer.concat(chunks));

    let signatureImageStorageKey: string | null = null;
    if (input.signingMethod === 'DRAWN_SIGNATURE') {
      const base64 = input.signatureImageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBytes = Buffer.from(base64, 'base64');
      signatureImageStorageKey = `esignatures/${tenantId}/${request.id}/signatures/${signer.id}.png`;
      await this.storage.uploadObject({ key: signatureImageStorageKey, body: imageBytes, contentType: 'image/png' });
    }

    const now = new Date();
    const updated = await tx.signatureSigner.update({
      where: { id: signer.id },
      data: {
        status: 'SIGNED',
        signedAt: now,
        signingMethod: input.signingMethod,
        typedSignatureText: input.signingMethod === 'TYPED_NAME' ? input.typedSignatureText : null,
        signatureImageStorageKey,
      },
    });

    await this.progress.recordEvent(tx, tenantId, request.id, 'SIGNED', {
      signerId: signer.id,
      actorUserId: signer.userId,
      actorExternalName: signer.externalName,
      actorExternalEmail: signer.externalEmail,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      signingMethod: input.signingMethod,
      documentHash: documentHashAtSigning,
      metadata: { consent: true },
    });

    await this.progress.advance(tx, tenantId, request.id);

    return updated;
  }

  async decline(
    tx: Prisma.TransactionClient,
    tenantId: string,
    signer: SignatureSigner,
    reason: string | undefined,
    meta: SigningRequestMeta,
  ): Promise<SignatureSigner> {
    this.assertSignable(signer);
    const updated = await tx.signatureSigner.update({ where: { id: signer.id }, data: { status: 'DECLINED', declinedAt: new Date() } });
    await this.progress.recordEvent(tx, tenantId, signer.signatureRequestId, 'DECLINED', {
      signerId: signer.id,
      actorUserId: signer.userId,
      actorExternalName: signer.externalName,
      actorExternalEmail: signer.externalEmail,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: reason ? { reason } : undefined,
    });
    await this.progress.advance(tx, tenantId, signer.signatureRequestId);
    return updated;
  }

  private assertSignable(signer: SignatureSigner): void {
    if (signer.status === 'SIGNED') {
      throw new BadRequestException('This document has already been signed.');
    }
    if (signer.status === 'DECLINED') {
      throw new BadRequestException('This document has already been declined.');
    }
    if (signer.status === 'PENDING') {
      throw new ForbiddenException('It is not yet your turn to sign this document.');
    }
  }
}
