import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { appPrisma } from '@hrm/db';
import { DEFAULT_RATE_LIMITS, RateLimitConfig, TenantEditionKey } from '@hrm/shared';
import { RateLimiterService } from '../../redis/rate-limiter.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';

const OVERRIDE_KEY_PREFIX = 'ratelimit:tenant-override:';
const EFFECTIVE_CACHE_PREFIX = 'ratelimit:tenant-effective:';
/**
 * How long a resolved (override-or-default) limit is cached before being
 * re-resolved. A deliberate, bounded staleness window — NOT the same
 * "must be fresh every call" posture 0.6's lifetime-license feature-flag
 * resolution requires (that's a security/entitlement boundary; a rate
 * limit briefly using yesterday's edition is not) — this is what keeps
 * the hot path to one Redis round trip per request instead of a Postgres
 * read on every single one. An override write invalidates this cache
 * immediately (see `setOverride`), so operator-initiated changes still
 * take effect on the very next request.
 */
const EFFECTIVE_CACHE_TTL_SECONDS = 30;

/**
 * Per-tenant request-volume limiting (step 0.10) — see /CLAUDE.md §
 * Conventions → Per-tenant rate limiting. Enforced by
 * `TenantScopeInterceptor` immediately after tenant resolution and BEFORE
 * `withTenantContext` opens the request's transaction, so a request that's
 * over budget never checks out a pooled DB connection at all — this is
 * deliberately the FIRST line of defense in the connection-pool
 * protection story (see /CLAUDE.md § Conventions → Connection-pool
 * protection), not just a courtesy 429.
 *
 * Resolution order: an explicit per-tenant override (Redis-only — no new
 * DB table; set via the platform-admin `PATCH /platform/rate-limits/:tenantId`
 * endpoint, same shape as 0.6's `TenantFeatureFlagOverride` lever but kept
 * out of Postgres entirely, consistent with this step's "keep everything
 * stateless, state in Redis" instruction) always wins; otherwise
 * `@hrm/shared`'s `DEFAULT_RATE_LIMITS[Tenant.edition]`.
 */
@Injectable()
export class TenantRateLimitService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /** Throws `TooManyAttemptsException` (429) once the tenant's current effective limit is exceeded. */
  async enforce(tenantId: string): Promise<void> {
    const config = await this.resolveEffectiveLimit(tenantId);
    await this.rateLimiter.consume(`tenant-quota:${tenantId}`, config.limit, config.windowSeconds);
  }

  /** Platform-admin lever — set (or, with `config: null`, clear) a tenant's override. Invalidates the cached effective value so the change is live immediately. */
  async setOverride(tenantId: string, config: RateLimitConfig | null): Promise<void> {
    const overrideKey = OVERRIDE_KEY_PREFIX + tenantId;
    if (config === null) {
      await this.redis.del(overrideKey);
    } else {
      await this.redis.set(overrideKey, JSON.stringify(config));
    }
    await this.redis.del(EFFECTIVE_CACHE_PREFIX + tenantId);
  }

  async getOverride(tenantId: string): Promise<RateLimitConfig | null> {
    const raw = await this.redis.get(OVERRIDE_KEY_PREFIX + tenantId);
    return raw ? (JSON.parse(raw) as RateLimitConfig) : null;
  }

  private async resolveEffectiveLimit(tenantId: string): Promise<RateLimitConfig> {
    const cached = await this.redis.get(EFFECTIVE_CACHE_PREFIX + tenantId);
    if (cached) {
      return JSON.parse(cached) as RateLimitConfig;
    }

    const override = await this.getOverride(tenantId);
    const config = override ?? DEFAULT_RATE_LIMITS[await this.resolveEdition(tenantId)];

    await this.redis.set(EFFECTIVE_CACHE_PREFIX + tenantId, JSON.stringify(config), 'EX', EFFECTIVE_CACHE_TTL_SECONDS);
    return config;
  }

  /**
   * Reads `Tenant.edition` directly via `appPrisma` with NO
   * `withTenantContext` transaction — `Tenant` is RLS-exempt (see
   * schema.prisma), the same reasoning `TenantResolutionService` documents
   * for resolving a tenant before a tenant context exists to open one
   * with. Deliberately `Tenant.edition`, not `Subscription.edition` — see
   * `@hrm/shared`'s `DEFAULT_RATE_LIMITS` doc comment for why.
   */
  private async resolveEdition(tenantId: string): Promise<TenantEditionKey> {
    const tenant = await appPrisma.tenant.findUnique({ where: { id: tenantId }, select: { edition: true } });
    return (tenant?.edition ?? 'STARTER') as TenantEditionKey;
  }
}
