import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, prisma, TenantBranding, TenantDomain } from '@hrm/db';
import { UpdateBrandingInput } from '@hrm/shared';
import { StorageService } from '../storage/storage.service';
import { BrandingResolutionService } from './branding-resolution.service';
import { generateVerificationToken, verificationRecordName, verificationRecordValue } from './domain-verification.service';

const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_FAVICON_SIZE_BYTES = 512 * 1024;

export interface DomainRequestResult {
  domain: TenantDomain;
  dnsRecordName: string;
  dnsRecordValue: string;
}

/**
 * Tenant-side branding mutations — see docs/conventions/white-label.md.
 * `TenantBranding` writes go through the caller's own RLS-scoped `tx`
 * (ordinary tenant data). `TenantDomain` writes deliberately do NOT —
 * that table stays RLS-EXEMPT (see the model comment in schema.prisma),
 * so they go through the OWNER `prisma` client, explicitly filtering by
 * `tenantId` in application code, the same pattern
 * `PlatformTenantService`/`StripeWebhookService` already use for
 * `Tenant.status` writes (RLS cannot help on an RLS-exempt table; the
 * application itself must be the enforcement).
 *
 * Every mutation invalidates `BrandingResolutionService`'s cache — a write
 * must never be visible only after the 60s TTL lapses.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly resolution: BrandingResolutionService,
    private readonly storage: StorageService,
  ) {}

  async getRow(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantBranding | null> {
    return tx.tenantBranding.findUnique({ where: { tenantId } });
  }

  async update(tx: Prisma.TransactionClient, tenantId: string, userId: string | null, input: UpdateBrandingInput): Promise<TenantBranding> {
    const row = await tx.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, updatedByUserId: userId, ...input },
      update: { updatedByUserId: userId, ...input },
    });
    await this.resolution.invalidate(tenantId);
    return row;
  }

  /** Gated at the ROUTE level via `@RequireFeature(FEATURE_FLAGS.FULL_REBRAND)` — this method assumes the caller is already entitled. */
  async updateRebrand(tx: Prisma.TransactionClient, tenantId: string, userId: string | null, enabled: boolean): Promise<TenantBranding> {
    const row = await tx.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, updatedByUserId: userId, fullRebrandEnabled: enabled },
      update: { updatedByUserId: userId, fullRebrandEnabled: enabled },
    });
    await this.resolution.invalidate(tenantId);
    return row;
  }

  async uploadLogo(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ): Promise<TenantBranding> {
    this.assertImage(file, MAX_LOGO_SIZE_BYTES, 'Logo');
    const key = `branding/${tenantId}/logo-${randomUUID()}-${sanitizeFileName(file.originalname)}`;
    await this.storage.uploadObject({ key, body: file.buffer, contentType: file.mimetype });
    const row = await tx.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, updatedByUserId: userId, logoStorageKey: key },
      update: { updatedByUserId: userId, logoStorageKey: key },
    });
    await this.resolution.invalidate(tenantId);
    return row;
  }

  async uploadFavicon(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ): Promise<TenantBranding> {
    this.assertImage(file, MAX_FAVICON_SIZE_BYTES, 'Favicon');
    const key = `branding/${tenantId}/favicon-${randomUUID()}-${sanitizeFileName(file.originalname)}`;
    await this.storage.uploadObject({ key, body: file.buffer, contentType: file.mimetype });
    const row = await tx.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, updatedByUserId: userId, faviconStorageKey: key },
      update: { updatedByUserId: userId, faviconStorageKey: key },
    });
    await this.resolution.invalidate(tenantId);
    return row;
  }

  async downloadLogo(tx: Prisma.TransactionClient, tenantId: string) {
    const row = await this.getRow(tx, tenantId);
    if (!row?.logoStorageKey) {
      throw new NotFoundException('No logo has been uploaded for this tenant.');
    }
    return this.storage.downloadObject(row.logoStorageKey);
  }

  async downloadFavicon(tx: Prisma.TransactionClient, tenantId: string) {
    const row = await this.getRow(tx, tenantId);
    if (!row?.faviconStorageKey) {
      throw new NotFoundException('No favicon has been uploaded for this tenant.');
    }
    return this.storage.downloadObject(row.faviconStorageKey);
  }

  private assertImage(file: { mimetype: string; size: number }, maxBytes: number, label: string): void {
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException(`${label} must be an image file.`);
    }
    if (file.size > maxBytes) {
      throw new BadRequestException(`${label} must be at most ${Math.round(maxBytes / 1024)}KB.`);
    }
  }

  // -- Custom domain requests — OWNER prisma client, see class doc comment above. --

  async getDomain(tenantId: string): Promise<TenantDomain | null> {
    return prisma.tenantDomain.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  async requestDomain(tenantId: string, userId: string | null, domain: string): Promise<DomainRequestResult> {
    const existing = await this.getDomain(tenantId);
    if (existing) {
      throw new BadRequestException(
        `This tenant already has a custom domain request ("${existing.domain}", status ${existing.verificationStatus}). Delete it first to request a different one.`,
      );
    }
    const verificationToken = generateVerificationToken();
    let row: TenantDomain;
    try {
      row = await prisma.tenantDomain.create({
        data: { tenantId, domain, verificationToken, requestedByUserId: userId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Domain "${domain}" is already in use by another tenant.`);
      }
      throw error;
    }
    return { domain: row, dnsRecordName: verificationRecordName(domain), dnsRecordValue: verificationRecordValue(verificationToken) };
  }

  async deleteDomain(tenantId: string, domainId: string): Promise<void> {
    const result = await prisma.tenantDomain.deleteMany({ where: { id: domainId, tenantId } });
    if (result.count === 0) {
      throw new NotFoundException(`No custom domain "${domainId}" was found for this tenant.`);
    }
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}
