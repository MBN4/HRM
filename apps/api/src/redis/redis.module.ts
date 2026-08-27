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
 */
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
        return new Redis(url);
      },
      inject: [ConfigService],
    },
    RateLimiterService,
  ],
  exports: [REDIS_CLIENT, RateLimiterService],
})
export class RedisModule {}
