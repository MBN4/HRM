import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@hrm/db';
import { EDITION_FEATURES, FeatureFlagKey, TenantEditionKey } from '@hrm/shared';
import { InvalidLicenseError, LicenseVerificationService } from './license-verification.service';
import { SeatCapService, SeatCapStatus } from './seat-cap.service';

export type LicenseMode = 'saas' | 'lifetime';

export interface EntitlementResolution {
  mode: LicenseMode;
  edition: TenantEditionKey | null;
  flags: FeatureFlagKey[];
  seatCap: SeatCapStatus | null;
  /** True when entitlement was forced to an empty flag set — no/invalid subscription (SaaS) or no/invalid/over-cap license (lifetime). */
  blocked: boolean;
}

/**
 * The one place `@RequireFeature`'s guard (and anything else that needs a
 * tenant's current entitlement) should ever call — see /CLAUDE.md §
 * Conventions → Licensing / feature flags for the full design. Deny-by-
 * default throughout: a missing/lapsed subscription, a missing/invalid/
 * over-cap license, or simply no data at all all resolve to an EMPTY flag
 * set, never a default-allow.
 *
 * Always queries through the caller's tenant-scoped transaction — every
 * table this reads (`subscriptions`, `licenses`, `tenant_feature_flag_overrides`)
 * is RLS-protected, same as every other tenant-aware service in this
 * codebase.
 */
@Injectable()
export class FeatureFlagResolutionService {
  constructor(
    private readonly config: ConfigService,
    private readonly verification: LicenseVerificationService,
    private readonly seatCapService: SeatCapService,
  ) {}

  mode(): LicenseMode {
    return this.config.get<string>('LICENSE_MODE') === 'lifetime' ? 'lifetime' : 'saas';
  }

  async resolve(tx: Prisma.TransactionClient, tenantId: string): Promise<EntitlementResolution> {
    const base = this.mode() === 'lifetime' ? await this.resolveLifetime(tx, tenantId) : await this.resolveSaas(tx, tenantId);

    const overrides = await tx.tenantFeatureFlagOverride.findMany({ where: { tenantId } });
    const flags = new Set(base.flags);
    for (const override of overrides) {
      if (override.enabled) {
        flags.add(override.flagKey as FeatureFlagKey);
      } else {
        flags.delete(override.flagKey as FeatureFlagKey);
      }
    }

    return { ...base, flags: [...flags] };
  }

  /**
   * SaaS mode: flags derive from the tenant's `Subscription.edition`
   * while `status` is TRIAL/ACTIVE. A CANCELED/PAST_DUE subscription (or
   * none at all) resolves to an empty flag set — this is the "disables
   * gated features" behavior this step's brief calls for.
   */
  private async resolveSaas(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Omit<EntitlementResolution, 'flags'> & { flags: FeatureFlagKey[] }> {
    const subscription = await tx.subscription.findUnique({ where: { tenantId } });
    const inGoodStanding = subscription !== null && (subscription.status === 'TRIAL' || subscription.status === 'ACTIVE');

    let seatCap: SeatCapStatus | null = null;
    if (subscription?.seatCap != null) {
      // SaaS mode: over-cap is FLAGGED (surfaced via GET /licensing/entitlements, audited from
      // there), never blocking — a tenant's paid features don't vanish because HR added one too
      // many employees; it's a billing conversation, not an outage.
      seatCap = await this.seatCapService.check(tx, subscription.seatCap);
    }

    return {
      mode: 'saas',
      edition: subscription?.edition ?? null,
      flags: inGoodStanding ? [...EDITION_FEATURES[subscription.edition as TenantEditionKey]] : [],
      seatCap,
      blocked: !inGoodStanding,
    };
  }

  /**
   * Lifetime mode: flags derive from the tenant's active `License` row's
   * signed payload, RE-VERIFIED against the RS256 public key on every
   * call (see LicenseVerificationService) — never trusted from the DB
   * snapshot alone. A missing license, a license that fails
   * re-verification (tampered/expired), or an over-cap license all
   * resolve to an empty flag set — over-cap BLOCKS in this mode, unlike
   * SaaS.
   */
  private async resolveLifetime(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Omit<EntitlementResolution, 'flags'> & { flags: FeatureFlagKey[] }> {
    const license = await tx.license.findFirst({ where: { tenantId, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' } });
    if (!license) {
      return { mode: 'lifetime', edition: null, flags: [], seatCap: null, blocked: true };
    }

    let verified;
    try {
      verified = this.verification.verify(license.signedToken);
    } catch (error) {
      if (error instanceof InvalidLicenseError) {
        return { mode: 'lifetime', edition: null, flags: [], seatCap: null, blocked: true };
      }
      throw error;
    }

    const seatCap = await this.seatCapService.check(tx, verified.payload.seatCap);
    if (seatCap.overCap) {
      return { mode: 'lifetime', edition: verified.payload.edition, flags: [], seatCap, blocked: true };
    }

    return {
      mode: 'lifetime',
      edition: verified.payload.edition,
      flags: [...verified.payload.enabledFlags] as FeatureFlagKey[],
      seatCap,
      blocked: false,
    };
  }
}
