import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export class TooManyAttemptsException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many attempts. Please try again later.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }

  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window counter backed by Redis (`INCR` + `EXPIRE` on the window's
 * first hit) — deliberately simple over a sliding-window/token-bucket
 * algorithm, which this scope doesn't need. Shared across all API
 * instances via Redis, so it works correctly under horizontal scaling
 * (an in-memory counter would not).
 *
 * Moved here from `auth/`, and `RedisModule` promoted to provide/export it
 * (step 0.10): originally auth-only (login/refresh/password-reset rate
 * limiting, 0.4), now also the algorithm `TenantRateLimitService` uses for
 * per-tenant request-volume limiting (see /CLAUDE.md § Conventions →
 * Per-tenant rate limiting) — a generic Redis rate-limiting primitive
 * belongs beside `RedisModule`, not owned by its first caller. No
 * behavior change for existing auth callers.
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Throws `TooManyAttemptsException` (429) once `key` has been hit more
   * than `limit` times within `windowSeconds`. Callers choose `key` to
   * scope the limit (e.g. `login:{tenantId}:{email}`, `reset:{email}`,
   * `tenant-quota:{tenantId}`).
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const redisKey = `ratelimit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }
    if (count > limit) {
      const ttl = await this.redis.ttl(redisKey);
      throw new TooManyAttemptsException(ttl > 0 ? ttl : windowSeconds);
    }
  }

  /**
   * Clears a key's counter — call on a SUCCESSFUL attempt (e.g. a correct
   * login) so legitimate rapid use isn't penalized by attempts that came
   * before it succeeded. The window only ever needs to punish a run of
   * failures, not a burst of successes.
   */
  async reset(key: string): Promise<void> {
    await this.redis.del(`ratelimit:${key}`);
  }
}
