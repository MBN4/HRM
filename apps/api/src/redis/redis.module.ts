import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * One shared `ioredis` connection for everything stateful that isn't
 * Postgres: refresh-token records and rate-limit counters today. Anything
 * that needs to survive across requests or be visible to other instances
 * belongs here, never in process memory — this is what keeps the API
 * horizontally scalable (see /CLAUDE.md § Conventions → Tenant resolution →
 * STATELESS).
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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
