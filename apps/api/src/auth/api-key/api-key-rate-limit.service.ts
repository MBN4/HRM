import { Injectable } from '@nestjs/common';
import { DEFAULT_API_KEY_RATE_LIMIT } from '@hrm/shared';
import { RateLimiterService } from '../../redis/rate-limiter.service';

/**
 * Per-API-KEY rate limiting (step 3.3) — a SECOND limiter alongside
 * `TenantRateLimitService`'s per-TENANT one; both run on every API-key
 * request (`TenantScopeInterceptor`), the same "no single layer trusted
 * alone" posture this codebase takes everywhere. Reuses the exact
 * `RateLimiterService` fixed-window primitive 0.10 already built — no new
 * algorithm, just a different key/limit.
 */
@Injectable()
export class ApiKeyRateLimitService {
  constructor(private readonly rateLimiter: RateLimiterService) {}

  async enforce(apiKeyId: string, overrideLimitPerMinute: number | null): Promise<void> {
    const limit = overrideLimitPerMinute ?? DEFAULT_API_KEY_RATE_LIMIT.limit;
    await this.rateLimiter.consume(`api-key:${apiKeyId}`, limit, DEFAULT_API_KEY_RATE_LIMIT.windowSeconds);
  }
}
