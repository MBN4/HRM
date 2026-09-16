import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RateLimiterService } from './rate-limiter.service';
import { REDIS_CLIENT } from './redis.constants';

/**
 * One shared `ioredis` connection for everything stateful that isn't
 * Postgres: refresh-token records and rate-limit counters today. Anything
 * that needs to survive across requests or be visible to other instances
 * belongs here, never in process memory — this is what keeps the API
 * horizontally scalable (see /CLAUDE.md § Conventions → Tenant resolution →
 * STATELESS).
 *
 * `RateLimiterService` is provided/exported here (moved from `auth/` in
 * 0.10) so it's usable from any module without an explicit import — the
 * same reasoning `TenancyModule` documents for its own `@Global()`, and
 * needed now that `TenantScopeInterceptor` (in `TenancyModule`) also
 * depends on it for per-tenant request-volume limiting.
 *
 * `commandTimeout` (Phase 6.4 — see docs/conventions/incident-response-dr.md
 * § Chaos experiments → "Redis down"): a real gap this step's own chaos
 * test caught. ioredis's OWN default behavior for a disconnected client
 * is to QUEUE commands and wait for reconnection (`enableOfflineQueue:
 * true`) rather than reject promptly — meaning EVERY Redis-touching call
 * site in this codebase (not only `TenantRateLimitService.enforce`, which
 * now ALSO has its own explicit fail-open/timeout for defense in depth —
 * `PermissionsCacheService.get` is the other one this chaos test actually
 * caught hanging) could sit blocked for far longer than any request
 * should ever wait. This ONE client-level setting bounds every command
 * issued through this shared connection uniformly, rather than requiring
 * every future caller to remember to wrap its own Redis calls in a
 * timeout — the same "fix it at the one shared layer, not at every call
 * site" reasoning `pool-config.ts`'s own `DB_POOL_TIMEOUT_SECONDS`
 * already applies to the DB connection pool. A healthy Redis round trip
 * locally is low-single-digit milliseconds, so this bound is never hit in
 * normal operation — only when Redis is genuinely unreachable/hanging.
 */
const REDIS_COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 2000);

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          throw new Error('REDIS_URL is not set.');
        }
        return new Redis(url, { commandTimeout: REDIS_COMMAND_TIMEOUT_MS });
      },
      inject: [ConfigService],
    },
    RateLimiterService,
  ],
  exports: [REDIS_CLIENT, RateLimiterService],
})
export class RedisModule {}
