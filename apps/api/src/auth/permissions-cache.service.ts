import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Prisma } from '@hrm/db';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { MetricsService } from '../metrics/metrics.service';
import { loadUserContext, LoadedUserContext } from './load-user-context.util';

const CACHE_NAME = 'permissions';

/**
 * A short TTL, not a "cache until told otherwise" one — see the class doc
 * comment for why this is the PRIMARY correctness mechanism today, not
 * just a backstop, for one specific write path.
 */
const CACHE_TTL_SECONDS = 15;

/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) — caches
 * `loadUserContext`'s result (roles/permissions/branch scope), THE hottest
 * resolve-fresh-every-request read in the whole system: every single
 * authenticated request pays for it inside `TenantScopeInterceptor`'s
 * `authenticate()` (see docs/conventions/auth-rbac.md), which is exactly
 * why 0.4/0.4's own doc flagged it as "resolved fresh per request —
 * cacheable" rather than left in the access token itself.
 *
 * **Does NOT cache whether the user is still ACTIVE.** `TenantScopeInterceptor`
 * re-checks `User.status` from the DB on every request BEFORE ever calling
 * into this cache (see its `authenticate()` method) — a deactivated user is
 * blocked immediately regardless of anything cached here. Only the
 * roles/permissions/branch-scope SHAPE is cached, never the account gate.
 *
 * **Honest gap, not silently glossed over**: as of this step, this
 * codebase has NO role-management or user-role-assignment MUTATION
 * endpoint at all (see docs/conventions/auth-rbac.md's own note — only
 * enforcement + seeding exist). That means there is no real write path to
 * hook an immediate `invalidate()` call into for "an admin edited a role's
 * permissions" or "an admin changed which roles a user holds" — the two
 * scenarios that would actually make a cached permission set stale. The
 * short 15s TTL above is therefore, for THOSE two scenarios, the PRIMARY
 * bound on staleness today, not merely a backstop the way it is for every
 * other cache in this step (country packs, entitlement, org structure all
 * have a real write path that busts them immediately). The one real write
 * path that DOES exist — provisioning a brand-new user's initial role
 * (`PlatformTenantService`'s tenant-admin bootstrap, `SsoService`'s
 * JIT provisioning) — DOES call `invalidate()` right after, defensively,
 * even though a brand-new user has no pre-existing cache entry to go stale.
 * The day a real role-editing endpoint is built, it MUST call
 * `invalidate(tenantId, userId)` for every affected user (or every holder
 * of an edited Role) as part of that work — exactly the same obligation
 * every other cached-write pair in this step already carries.
 */
@Injectable()
export class PermissionsCacheService {
  private readonly logger = new Logger(PermissionsCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * FAILS OPEN onto the uncached path when Redis itself is unreachable —
   * a real gap Phase 6.4's chaos testing caught: this runs inside
   * `TenantScopeInterceptor.authenticate()` for EVERY authenticated
   * request, THE hottest read in the system per this class's own doc
   * comment, and previously had no error handling around its Redis calls
   * at all. Bounded by `RedisModule`'s own `commandTimeout` (so a hung
   * Redis connection fails fast, not eventually); a genuine Redis error
   * here degrades to "always compute from Postgres, never cache" rather
   * than failing the request — correctness is unaffected (this is a
   * cache, `loadUserContext` is always the source of truth), only the hit
   * rate drops to zero for the outage's duration, which is a strictly
   * better outcome than a 500. The SAME `hrm_redis_unavailable_fail_open_total`
   * metric `TenantRateLimitService.enforce` uses records this too, keyed
   * `check="permissions-cache"` — one dashboard, every Redis-dependent
   * hot-path fallback visible together.
   */
  async getContext(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<LoadedUserContext> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(this.cacheKey(tenantId, userId));
    } catch (error) {
      this.logger.warn(`Permissions cache read failed open — Redis unreachable: ${(error as Error).message}`);
      this.metrics.incRedisUnavailableFailOpen('permissions-cache');
    }
    if (cached) {
      this.metrics.recordCacheHit(CACHE_NAME);
      return JSON.parse(cached) as LoadedUserContext;
    }
    this.metrics.recordCacheMiss(CACHE_NAME);

    const context = await loadUserContext(tx, userId);
    try {
      await this.redis.set(this.cacheKey(tenantId, userId), JSON.stringify(context), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Permissions cache write failed open — Redis unreachable: ${(error as Error).message}`);
      this.metrics.incRedisUnavailableFailOpen('permissions-cache');
    }
    return context;
  }

  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tenantId, userId));
  }

  private cacheKey(tenantId: string, userId: string): string {
    return `permissions:${tenantId}:${userId}`;
  }
}
