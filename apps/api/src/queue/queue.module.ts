import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

/**
 * THE REUSABLE PATTERN for every future background job in this system
 * (notifications today; payroll runs, report generation, bulk imports
 * later — see /CLAUDE.md § Conventions → Notifications → Async delivery
 * (BullMQ)). This module owns exactly ONE thing: the shared Redis
 * connection OPTIONS every BullMQ queue/worker in the process is
 * configured with, set once, globally.
 *
 * A future module does NOT need to touch this file — it just does, in its
 * own module:
 *
 *   @Module({
 *     imports: [BullModule.registerQueue({ name: 'payroll-runs' })],
 *     providers: [PayrollRunsProcessor], // extends WorkerHost, @Processor('payroll-runs')
 *   })
 *
 * and gets a fully working, retryable, backed-off queue for free — see
 * `notifications/notifications.module.ts` for a complete worked example
 * (`registerQueue` + a `@Processor` class) and
 * `notifications/notification.processor.ts` for the dead-letter pattern
 * (mark failure in the DB in the LAST attempt, rather than relying on a
 * second physical queue BullMQ's open-source tier doesn't provide).
 *
 * `connection` is passed as plain `host`/`port`/`password` OPTIONS, not a
 * hand-constructed `ioredis` instance: given options, BullMQ opens and —
 * critically — OWNS the underlying connections for every Queue/Worker/
 * QueueEvents it creates, so `app.close()`'s normal `onApplicationShutdown`
 * lifecycle closes them all automatically (verified — a hand-shared
 * connection instance is not reliably closed the same way, since BullMQ
 * treats an externally-provided client as caller-owned and leaves its
 * lifecycle to the caller). `maxRetriesPerRequest: null` is BullMQ's own
 * documented requirement for any connection used by a Worker (it issues
 * blocking commands that must not be subject to ioredis's normal
 * retry-then-give-up behavior). This is a separate physical connection
 * pool from `RedisModule`'s `REDIS_CLIENT` (refresh tokens / rate
 * limiting), which must NOT set `maxRetriesPerRequest: null` — the two are
 * deliberately not shared.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          throw new Error('REDIS_URL is not set.');
        }
        const parsed = new URL(url);
        return {
          connection: {
            host: parsed.hostname,
            port: Number(parsed.port || 6379),
            password: parsed.password || undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
