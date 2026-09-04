import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, withTenantContext } from '@hrm/db';
import type { TenantDomain } from '@hrm/db';
import { AuditRecordService } from '../../audit/audit-record.service';
import { BrandingResolutionService } from '../../branding/branding-resolution.service';
import { CERT_PROVIDER, CertProvider } from '../../branding/cert/cert-provider.interface';
import { DomainVerificationService } from '../../branding/domain-verification.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface PlatformBrandingSummary {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  productName: string | null;
  hasLogo: boolean;
  fullRebrandEnabled: boolean;
  domain: { id: string; domain: string; verificationStatus: string; certStatus: string } | null;
}

/**
 * The vendor console's branding oversight surface (step 4.3) — list every
 * tenant's branding/domain state, verify or manually approve a branded
 * custom domain, provision its TLS certificate, and force-reset a
 * tenant's branding to defaults. See docs/conventions/white-label.md.
 *
 * Every mutation is dual-audited exactly like `PlatformTenantService`
 * (4.1)/`PlatformBillingService` (4.2): the TARGET TENANT's own
 * `audit_log` (via `AuditRecordService.recordForTenant`, `actorPlatform:
 * true`) AND the platform's consolidated `PlatformAuditLog` — a tenant can
 * always see for themselves, in their OWN audit trail, that the vendor
 * touched their branding/domain, never only in a trail they can't see.
 *
 * `TenantDomain` writes go through the OWNER `prisma` client (that table
 * is RLS-exempt — see schema.prisma), scoped explicitly by `tenantId` in
 * every query, same as `BrandingService`'s own tenant-side domain methods.
 * `TenantBranding` writes go through `withTenantContext` (ordinary RLS),
 * the same "wrap the write in the target tenant's own context" pattern
 * `PlatformBillingService.getTenantBilling`/`resyncSubscription` already
 * use.
 */
@Injectable()
export class PlatformBrandingService {
  constructor(
    private readonly resolution: BrandingResolutionService,
    private readonly domainVerification: DomainVerificationService,
    @Inject(CERT_PROVIDER) private readonly certProvider: CertProvider,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
  ) {}

  /** Cheap indexed reads only — the SAME posture PlatformUsageService/PlatformBillingService.listSubscriptions already document for themselves. */
  async listBrandings(): Promise<PlatformBrandingSummary[]> {
    const [tenants, brandings, domains] = await Promise.all([
      prisma.tenant.findMany({ select: { id: true, name: true, slug: true }, orderBy: { createdAt: 'desc' } }),
      prisma.tenantBranding.findMany(),
      prisma.tenantDomain.findMany({ orderBy: { createdAt: 'desc' } }),
    ]);
    const brandingByTenant = new Map(brandings.map((b) => [b.tenantId, b]));
    const domainByTenant = new Map<string, TenantDomain>();
    for (const domain of domains) {
      if (!domainByTenant.has(domain.tenantId)) {
        domainByTenant.set(domain.tenantId, domain);
      }
    }

    return tenants.map((tenant) => {
      const branding = brandingByTenant.get(tenant.id);
      const domain = domainByTenant.get(tenant.id);
      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        productName: branding?.productName ?? null,
        hasLogo: Boolean(branding?.logoStorageKey),
        fullRebrandEnabled: branding?.fullRebrandEnabled ?? false,
        domain: domain
          ? { id: domain.id, domain: domain.domain, verificationStatus: domain.verificationStatus, certStatus: domain.certStatus }
          : null,
      };
    });
  }

  async getTenantDomain(tenantId: string): Promise<TenantDomain | null> {
    await this.requireTenant(tenantId);
    return prisma.tenantDomain.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  /** The REAL production path — a live DNS TXT lookup. See DomainVerificationService's own doc comment for why `approveDomain` also exists. */
  async verifyDomain(actorId: string, tenantId: string, domainId: string): Promise<TenantDomain> {
    const domain = await this.requireDomain(tenantId, domainId);
    const verified = await this.domainVerification.verify(domain.domain, domain.verificationToken);
    const updated = await prisma.tenantDomain.update({
      where: { id: domainId },
      data: { verificationStatus: verified ? 'VERIFIED' : 'FAILED' },
    });
    await this.dualAudit(actorId, tenantId, 'branding.domain_verification_attempted', 'TenantDomain', domainId, {
      domain: domain.domain,
      verified,
    });
    return updated;
  }

  /**
   * A manual override — sets VERIFIED directly, WITHOUT a live DNS check.
   * Loudly audited (never a silent bypass), the same documented
   * "real dependency this sandboxed environment can't fully exercise, so
   * a manual/mock fallback exists alongside the real path" posture 4.1's
   * impersonation and 4.2's billing flows already establish.
   */
  async approveDomain(actorId: string, tenantId: string, domainId: string): Promise<TenantDomain> {
    const domain = await this.requireDomain(tenantId, domainId);
    const updated = await prisma.tenantDomain.update({ where: { id: domainId }, data: { verificationStatus: 'VERIFIED' } });
    await this.dualAudit(actorId, tenantId, 'branding.domain_manually_approved', 'TenantDomain', domainId, { domain: domain.domain });
    return updated;
  }

  async provisionTls(actorId: string, tenantId: string, domainId: string): Promise<TenantDomain> {
    const domain = await this.requireDomain(tenantId, domainId);
    if (domain.verificationStatus !== 'VERIFIED') {
      throw new BadRequestException('The domain must be VERIFIED before a certificate can be provisioned for it.');
    }
    const result = await this.certProvider.provisionCertificate(domain.domain);
    const updated = await prisma.tenantDomain.update({
      where: { id: domainId },
      data: {
        certStatus: result.status,
        certProvisionedAt: result.status === 'ISSUED' ? new Date() : null,
        certExpiresAt: result.expiresAt ?? null,
      },
    });
    await this.dualAudit(actorId, tenantId, 'branding.tls_provisioned', 'TenantDomain', domainId, {
      domain: domain.domain,
      certStatus: result.status,
    });
    return updated;
  }

  /** Force-resets a tenant's branding to plain defaults — an oversight lever for a policy violation or a customer support request, not a routine action. */
  async resetBranding(actorId: string, tenantId: string): Promise<void> {
    await this.requireTenant(tenantId);
    await withTenantContext(tenantId, (tx) => tx.tenantBranding.deleteMany({ where: { tenantId } }));
    await this.resolution.invalidate(tenantId);
    await this.dualAudit(actorId, tenantId, 'branding.reset', 'TenantBranding', tenantId, {});
  }

  private async requireTenant(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${id}" was not found.`);
    }
    return tenant;
  }

  private async requireDomain(tenantId: string, domainId: string): Promise<TenantDomain> {
    await this.requireTenant(tenantId);
    const domain = await prisma.tenantDomain.findFirst({ where: { id: domainId, tenantId } });
    if (!domain) {
      throw new NotFoundException(`No custom domain "${domainId}" was found for tenant "${tenantId}".`);
    }
    return domain;
  }

  private async dualAudit(
    actorId: string,
    tenantId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action,
      entityType,
      entityId,
      after,
      metadata: { platformAdminId: actorId },
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action,
      entityType,
      entityId,
      targetTenantId: tenantId,
      after,
    });
  }
}
