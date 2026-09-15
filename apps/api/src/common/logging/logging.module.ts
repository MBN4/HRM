import { Global, Module } from '@nestjs/common';
import { ERROR_TRACKER } from './error-tracker.constants';
import { sharedErrorTracker } from './error-tracker';

/**
 * Phase 5.4 — exposes the SAME `sharedErrorTracker` singleton
 * `PinoLoggerService.error()` already forwards to (see error-tracker.ts's
 * own doc comment for why it's a plain module-level singleton rather than
 * a container-resolved provider at its point of origin) as an injectable,
 * for any service that wants to call `captureException` explicitly rather
 * than only implicitly via a `Logger.error(...)` call — e.g. a background
 * job that catches an error, records it in its own status column, AND
 * still wants it tracked, without also wanting the noisy stdout `.error()`
 * line `PinoLoggerService` would otherwise produce.
 */
@Global()
@Module({
  providers: [{ provide: ERROR_TRACKER, useValue: sharedErrorTracker }],
  exports: [ERROR_TRACKER],
})
export class LoggingModule {}
