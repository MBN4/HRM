import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { appPrisma } from '@hrm/db';
import { DEFAULT_RATE_LIMITS, RateLimitConfig, TenantEditionKey } from '@hrm/shared';
import { RateLimiterService, TooManyAttemptsException } from '../../redis/rate-limiter.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { MetricsService } from '../../metrics/metrics.service';

/** See `enforce`'s own doc comment for why this bound exists. */
const REDIS_UNAVAILABLE_TIMEOUT_MS = Number(process.env.REDIS_UNAVAILABLE_TIMEOUT_MS ?? 750);

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
  private readonly logger = new Logger(TenantRateLimitService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rateLimiter: RateLimiterService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Throws `TooManyAttemptsException` (429) once the tenant's current
   * effective limit is exceeded. FAILS OPEN when Redis itself is
   * unreachable — a real gap Phase 6.4's chaos testing found (see
   * docs/conventions/incident-response-dr.md § Chaos experiments →
   * "Redis down"): this runs on `TenantScopeInterceptor`'s hot path for
   * EVERY tenant-scoped request, BEFORE the DB transaction even opens: an
   * uncaught Redis connection error here previously surfaced as a raw,
   * uninformative 500 for every single request the instant Redis became
   * unreachable — a total outage caused by a DEGRADED (not even fully
   * down, in a real deployment with a replica) dependency, exactly the
   * single-point-of-failure this chassis's own "no layer trusted alone"
   * posture argues against. A deliberate tradeoff, the same shape as
   * load shedding's own per-instance `SystemLoadService` exception: rate
   * limiting exists to protect shared capacity from a runaway tenant, not
   * to protect the app from users when it's already unavailable — failing
   * OPEN (unmetered, but still SERVED) beats failing the whole app CLOSED
   * over a dependency this feature alone doesn't strictly need to
   * function. `TooManyAttemptsException` (a real, intentional 429) is
   * re-thrown untouched — only a genuine Redis-reachability failure is
   * swallowed. Every fail-open event increments a dedicated metric (see
   * `MetricsService.incRedisUnavailableFailOpen`) so it's a visible,
   * alertable signal, never a silent gap.
   *
   * Bounded by `REDIS_UNAVAILABLE_TIMEOUT_MS`: ioredis's OWN default
   * behavior for a disconnected client is to QUEUE commands and wait for
   * reconnection (`enableOfflineQueue: true`) rather than reject
   * immediately — a real gap this step's own chaos test caught, since a
   * plain `try/catch` alone did nothing until ioredis's internal
   * `maxRetriesPerRequest` budget was exhausted, which can take far
   * longer than this request should ever wait. Racing against a short
   * local timeout here (the SAME `Promise.race` idiom
   * `CircuitBreakerService.withTimeout` already establishes) makes the
   * fail-open behavior actually fail open QUICKLY, instead of merely
   * eventually.
   */
  async enforce(tenantId: string): Promise<void> {
    try {
      await this.withTimeout(
        (async () => {
          const config = await this.resolveEffectiveLimit(tenantId);
          await this.rateLimiter.consume(`tenant-quota:${tenantId}`, config.limit, config.windowSeconds);
        })(),
      );
    } catch (error) {
      if (error instanceof TooManyAttemptsException) {
        throw error;
      }
      this.logger.warn(`Rate limiting failed open for tenant ${tenantId} — Redis unreachable: ${(error as Error).message}`);
      this.metrics.incRedisUnavailableFailOpen('tenant-rate-limit');
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = REDIS_UNAVAILABLE_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Redis call exceeded ${timeoutMs}ms — treating as unreachable.`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
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

  /**
   * Step 4.1 — a LIVE snapshot of the tenant's current fixed-window
   * request count, for the vendor console's usage dashboard's "API-call
   * volume" tile. Deliberately NOT a historical rollup (none exists for
   * request volume today — this is a documented gap, see
   * docs/conventions/vendor-console.md → Usage metrics): reads the SAME
   * Redis counter `enforce()` already increments, at zero extra cost —
   * never a live aggregate over a Postgres table.
   */
  async getCurrentWindowUsage(tenantId: string): Promise<{ count: number; limit: number; windowSeconds: number }> {
    const config = await this.resolveEffectiveLimit(tenantId);
    const raw = await this.redis.get(`ratelimit:tenant-quota:${tenantId}`);
    return { count: raw ? Number(raw) : 0, limit: config.limit, windowSeconds: config.windowSeconds };
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
