import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Prisma, SignatureRequest } from '@hrm/db';
import type {
  CreateGeneratedSignatureRequestInput,
  CreateUploadedSignatureRequestFields,
  SignerInput,
} from '@hrm/shared';
import { PERMISSIONS } from '@hrm/shared';
import { StorageService } from '../storage/storage.service';
import { SignableDocumentPdfService } from './signable-document-pdf.service';
import { SigningProgressService } from './signing-progress.service';
import { sha256Hex } from './document-hash.util';
import { MAX_LIST_RESULTS, OFFER_ENTITY_TYPE, POLICY_ENTITY_TYPE } from './esignature.constants';

export interface UploadedDocumentInput {
  buffer: Buffer;
  mimetype: string;
}

/**
 * Signature-request CRUD/orchestration — see docs/conventions/e-signatures.md.
 * Owns NO sequencing logic itself (`SigningProgressService` does) and NO
 * per-signer signing logic itself (`SigningService` does) — this service's
 * job is: resolve/render the source document + hash it once, create the
 * polymorphic request + its signers, and the coarse request-level actions
 * (send/cancel/list/verify).
 */
@Injectable()
export class SignatureRequestService {
  constructor(
    private readonly storage: StorageService,
    private readonly pdf: SignableDocumentPdfService,
    private readonly progress: SigningProgressService,
  ) {}

  async createGenerated(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    callerPermissions: string[],
    input: CreateGeneratedSignatureRequestInput,
  ): Promise<SignatureRequest> {
    const resolved = await this.resolveGeneratedDocument(tx, input);
    this.assertMayCreate(callerPermissions, callerUserId, input.generate.kind, resolved.entityType, input.signers);

    const bytes = await this.pdf.renderTextDocument({ title: resolved.title, paragraphs: resolved.paragraphs });
    const id = randomUUID();
    const storageKey = `esignatures/${tenantId}/${id}/document.pdf`;
    await this.storage.uploadObject({ key: storageKey, body: bytes, contentType: 'application/pdf' });

    return this.persistRequest(tx, tenantId, callerUserId, {
      id,
      title: input.title ?? resolved.title,
      entityType: input.entityType ?? resolved.entityType,
      entityId: input.entityId ?? resolved.entityId,
      branchId: input.branchId ?? resolved.branchId,
      documentSource: 'GENERATED',
      documentStorageKey: storageKey,
      documentMimeType: 'application/pdf',
      documentHash: sha256Hex(bytes),
      signers: input.signers,
      expiresInDays: input.expiresInDays,
    });
  }

  async createFromUpload(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    callerPermissions: string[],
    fields: CreateUploadedSignatureRequestFields,
    signers: SignerInput[],
    file: UploadedDocumentInput,
  ): Promise<SignatureRequest> {
    if (!callerPermissions.includes(PERMISSIONS.ESIGNATURE_REQUEST)) {
      throw new ForbiddenException('You do not have permission to create a signature request.');
    }
    const id = randomUUID();
    const storageKey = `esignatures/${tenantId}/${id}/document`;
    await this.storage.uploadObject({ key: storageKey, body: file.buffer, contentType: file.mimetype });

    return this.persistRequest(tx, tenantId, callerUserId, {
      id,
      title: fields.title,
      entityType: fields.entityType ?? null,
      entityId: fields.entityId ?? null,
      branchId: fields.branchId ?? null,
      documentSource: 'UPLOADED',
      documentStorageKey: storageKey,
      documentMimeType: file.mimetype,
      documentHash: sha256Hex(file.buffer),
      signers,
      expiresInDays: fields.expiresInDays,
    });
  }

  async send(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<SignatureRequest> {
    const request = await this.requireById(tx, tenantId, id);
    if (request.status !== 'DRAFT') {
      throw new ConflictException(`Signature request "${id}" is "${request.status}" and can no longer be sent.`);
    }
    await tx.signatureRequest.update({ where: { id }, data: { sentAt: new Date() } });
    await this.progress.recordEvent(tx, tenantId, id, 'SENT');
    await this.progress.advance(tx, tenantId, id);
    return this.requireById(tx, tenantId, id);
  }

  async cancel(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<SignatureRequest> {
    const request = await this.requireById(tx, tenantId, id);
    if (request.status === 'COMPLETED' || request.status === 'CANCELED' || request.status === 'DECLINED') {
      throw new ConflictException(`Signature request "${id}" is "${request.status}" and cannot be canceled.`);
    }
    const canceled = await tx.signatureRequest.update({ where: { id }, data: { status: 'CANCELED' } });
    await this.progress.recordEvent(tx, tenantId, id, 'EXPIRED', { metadata: { reason: 'canceled' } });
    return canceled;
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    filters: { status?: string; entityType?: string },
  ): Promise<SignatureRequest[]> {
    return tx.signatureRequest.findMany({
      where: {
        tenantId,
        ...(filters.status ? { status: filters.status as SignatureRequest['status'] } : {}),
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(allowedBranchIds ? { OR: [{ branchId: null }, { branchId: { in: allowedBranchIds } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST_RESULTS,
    });
  }

  async findWithSigners(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const request = await tx.signatureRequest.findFirst({
      where: { tenantId, id },
      include: { signers: { orderBy: { order: 'asc' } }, certificate: true },
    });
    if (!request) {
      throw new NotFoundException(`Signature request "${id}" was not found.`);
    }
    return request;
  }

  async getDocument(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const request = await this.requireById(tx, tenantId, id);
    const object = await this.storage.downloadObject(request.documentStorageKey);
    return { object, mimeType: request.documentMimeType, title: request.title };
  }

  async getCertificate(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const certificate = await tx.signatureCertificate.findFirst({ where: { tenantId, signatureRequestId: id } });
    if (!certificate) {
      throw new NotFoundException(`No certificate exists yet for signature request "${id}" (it may not be COMPLETED).`);
    }
    return this.storage.downloadObject(certificate.storageKey);
  }

  /** Tamper-evidence check — recomputes the CURRENT stored object's hash and compares against the hash recorded at creation. See docs/conventions/e-signatures.md. */
  async verifyIntegrity(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const request = await this.requireById(tx, tenantId, id);
    const object = await this.storage.downloadObject(request.documentStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      chunks.push(chunk as Buffer);
    }
    const actualHash = sha256Hex(Buffer.concat(chunks));
    return { valid: actualHash === request.documentHash, expectedHash: request.documentHash, actualHash };
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<SignatureRequest> {
    const request = await tx.signatureRequest.findFirst({ where: { tenantId, id } });
    if (!request) {
      throw new NotFoundException(`Signature request "${id}" was not found.`);
    }
    return request;
  }

  /** Row-level carve-out for a self-service policy acknowledgment — see docs/conventions/e-signatures.md → Permissions. Everything else needs `esignature.request`. */
  private assertMayCreate(
    callerPermissions: string[],
    callerUserId: string,
    kind: CreateGeneratedSignatureRequestInput['generate']['kind'],
    entityType: string | null,
    signers: SignerInput[],
  ): void {
    if (callerPermissions.includes(PERMISSIONS.ESIGNATURE_REQUEST)) {
      return;
    }
    const isSelfPolicyAck =
      kind === 'POLICY' &&
      entityType === POLICY_ENTITY_TYPE &&
      signers.length === 1 &&
      signers[0].signerType === 'INTERNAL' &&
      signers[0].userId === callerUserId &&
      callerPermissions.includes(PERMISSIONS.POLICY_READ);
    if (!isSelfPolicyAck) {
      throw new ForbiddenException('You do not have permission to create a signature request.');
    }
  }

  private async resolveGeneratedDocument(
    tx: Prisma.TransactionClient,
    input: CreateGeneratedSignatureRequestInput,
  ): Promise<{ title: string; paragraphs: string[]; entityType: string | null; entityId: string | null; branchId: string | null }> {
    if (input.generate.kind === 'OFFER_LETTER') {
      const offer = await tx.offer.findUnique({ where: { id: input.generate.offerId }, include: { application: { include: { candidate: true } }, branch: true } });
      if (!offer) {
        throw new NotFoundException(`Offer "${input.generate.offerId}" was not found.`);
      }
      const candidate = offer.application.candidate;
      const paragraphs = [
        `Dear ${candidate.firstName} ${candidate.lastName},`,
        `We are pleased to offer you a position at ${offer.branch.name} as a ${offer.employmentType.replace('_', ' ').toLowerCase()} employee, starting on ${offer.proposedJoinDate.toISOString().slice(0, 10)}.`,
        `Your proposed compensation is ${offer.proposedSalary.toString()} ${offer.salaryCurrency} per month.`,
        'Please review the terms of this offer and sign below to indicate your acceptance.',
      ];
      return {
        title: `Offer Letter — ${candidate.firstName} ${candidate.lastName}`,
        paragraphs,
        entityType: OFFER_ENTITY_TYPE,
        entityId: offer.id,
        branchId: offer.branchId,
      };
    }
    if (input.generate.kind === 'POLICY') {
      const policy = await tx.policy.findUnique({ where: { id: input.generate.policyId } });
      if (!policy) {
        throw new NotFoundException(`Policy "${input.generate.policyId}" was not found.`);
      }
      const paragraphs = policy.body
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return {
        title: `Policy Acknowledgment — ${policy.title} (v${policy.version})`,
        paragraphs: paragraphs.length > 0 ? paragraphs : [policy.body],
        entityType: POLICY_ENTITY_TYPE,
        entityId: policy.id,
        branchId: null,
      };
    }
    return { title: input.generate.title, paragraphs: input.generate.paragraphs, entityType: null, entityId: null, branchId: null };
  }

  private async persistRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    params: {
      id: string;
      title: string;
      entityType: string | null;
      entityId: string | null;
      branchId: string | null;
      documentSource: 'UPLOADED' | 'GENERATED';
      documentStorageKey: string;
      documentMimeType: string;
      documentHash: string;
      signers: SignerInput[];
      expiresInDays: number;
    },
  ): Promise<SignatureRequest> {
    const expiresAt = new Date(Date.now() + params.expiresInDays * 86_400_000);

    const request = await tx.signatureRequest.create({
      data: {
        id: params.id,
        tenantId,
        title: params.title,
        entityType: params.entityType,
        entityId: params.entityId,
        branchId: params.branchId,
        documentSource: params.documentSource,
        documentStorageKey: params.documentStorageKey,
        documentMimeType: params.documentMimeType,
        documentHash: params.documentHash,
        createdByUserId: callerUserId,
        expiresAt,
      },
    });

    await tx.signatureSigner.createMany({
      data: params.signers.map((signer) => ({
        tenantId,
        signatureRequestId: request.id,
        order: signer.order,
        signerType: signer.signerType,
        userId: signer.signerType === 'INTERNAL' ? signer.userId : null,
        externalName: signer.signerType === 'EXTERNAL' ? signer.externalName : null,
        externalEmail: signer.signerType === 'EXTERNAL' ? signer.externalEmail : null,
      })),
    });

    await this.progress.recordEvent(tx, tenantId, request.id, 'CREATED', { actorUserId: callerUserId });

    return request;
  }
}
