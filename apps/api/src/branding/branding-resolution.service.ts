import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Prisma, TenantBranding } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { DEFAULT_PRODUCT_NAME } from '@hrm/shared';
import { REDIS_CLIENT } from '../redis/redis.constants';

const CACHE_TTL_SECONDS = 60;

export interface EffectiveBranding {
  productName: string;
  logoStorageKey: string | null;
  faviconStorageKey: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  loginHeadline: string | null;
  loginSubtext: string | null;
  emailFromName: string | null;
  emailFromAddress: string | null;
  /**
   * The tenant's stored INTENT, not a granted entitlement — a caller
   * MUST re-check the live FULL_REBRAND feature flag before acting on
   * this (see BrandingController.resolveShowPoweredBy). Kept here purely
   * because it's cheap to carry alongside the rest of the cached row.
   */
  fullRebrandEnabled: boolean;
}

const DEFAULT_BRANDING: EffectiveBranding = {
  productName: DEFAULT_PRODUCT_NAME,
  logoStorageKey: null,
  faviconStorageKey: null,
  primaryColor: null,
  secondaryColor: null,
  accentColor: null,
  loginHeadline: null,
  loginSubtext: null,
  emailFromName: null,
  emailFromAddress: null,
  fullRebrandEnabled: false,
};

/**
 * Resolves the EFFECTIVE branding for a tenant — see
 * docs/conventions/white-label.md. A tenant with no `TenantBranding` row at
 * all (the common case) resolves the plain product defaults, the same
 * "absence means default" posture `NotificationPreference` already takes
 * for itself (see docs/conventions/notifications-queues.md).
 *
 * This is a HOT-PATH read — every portal/mobile page load, every outbound
 * email render, and the pre-login screen all resolve it — so results are
 * cached in Redis (`branding:<tenantId>`, a short 60s TTL) the same way
 * `IdempotencyService`/`RateLimiterService` already use `REDIS_CLIENT` for
 * request-scoped-but-cross-instance state (see
 * docs/conventions/resilience.md). `BrandingService` explicitly
 * INVALIDATES this cache on every write rather than relying on the TTL
 * alone to pick up a change — the TTL exists as a safety net (a missed
 * invalidation self-heals within a minute), not the primary consistency
 * mechanism.
 *
 * `fullRebrandEnabled` is cached alongside the rest (it's just a stored
 * bit) but is NOT itself an entitlement — a caller must always re-check
 * the LIVE `FEATURE_FLAGS.FULL_REBRAND` flag before hiding vendor identity
 * (see `BrandingController.resolveShowPoweredBy`), the same "never cache
 * entitlement itself, only re-derive from it" posture
 * `FeatureFlagGuard`/`@RequireFeature` already document for themselves —
 * a lapsed subscription/license must restore the "Powered by" footer
 * immediately, not up to a minute later.
 */
@Injectable()
export class BrandingResolutionService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** For a caller already inside the tenant's own RLS-scoped transaction (an ordinary tenant request, incl. `@AllowAnonymous()` ones — tenant resolution still runs for those). */
  async resolve(tx: Prisma.TransactionClient, tenantId: string): Promise<EffectiveBranding> {
    const cached = await this.getCached(tenantId);
    if (cached) {
      return cached;
    }
    const row = await tx.tenantBranding.findUnique({ where: { tenantId } });
    const effective = this.merge(row);
    await this.setCached(tenantId, effective);
    return effective;
  }

  /**
   * For a caller with no open tenant-scoped transaction (the notification
   * worker, outside any request) — same constraint
   * `NotificationLocaleResolverService` documents for itself. Checks the
   * cache first so the common (warm) case never even opens a transaction.
   */
  async resolveForTenantId(tenantId: string): Promise<EffectiveBranding> {
    const cached = await this.getCached(tenantId);
    if (cached) {
      return cached;
    }
    return withTenantContext(tenantId, (tx) => this.resolve(tx, tenantId));
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tenantId));
  }

  private merge(row: TenantBranding | null): EffectiveBranding {
    if (!row) {
      return DEFAULT_BRANDING;
    }
    return {
      productName: row.productName ?? DEFAULT_PRODUCT_NAME,
      logoStorageKey: row.logoStorageKey,
      faviconStorageKey: row.faviconStorageKey,
      primaryColor: row.primaryColor,
      secondaryColor: row.secondaryColor,
      accentColor: row.accentColor,
      loginHeadline: row.loginHeadline,
      loginSubtext: row.loginSubtext,
      emailFromName: row.emailFromName,
      emailFromAddress: row.emailFromAddress,
      fullRebrandEnabled: row.fullRebrandEnabled,
    };
  }

  private cacheKey(tenantId: string): string {
    return `branding:${tenantId}`;
  }

  private async getCached(tenantId: string): Promise<EffectiveBranding | null> {
    const raw = await this.redis.get(this.cacheKey(tenantId));
    return raw ? (JSON.parse(raw) as EffectiveBranding) : null;
  }

  private async setCached(tenantId: string, value: EffectiveBranding): Promise<void> {
    await this.redis.set(this.cacheKey(tenantId), JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
  }
}
