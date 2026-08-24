import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AuthEventPayload } from '../auth-events';

/**
 * Placeholder consumer for every `auth.*` domain event (see auth-events.ts)
 * — logs them structured so they're visible today. 0.9 (audit logging)
 * replaces this listener with real persistence into the (future,
 * partitioned) `audit_log` table; the event contract in auth-events.ts is
 * what 0.9 should build against, not this listener's implementation.
 *
 * Requires `EventEmitterModule.forRoot({ wildcard: true })` (see
 * app.module.ts) for the `'auth.*'` pattern to match at all.
 */
@Injectable()
export class AuditEventsListener {
  private readonly logger = new Logger('AuditEvent');

  @OnEvent('auth.*')
  handleAuthEvent(payload: AuthEventPayload): void {
    this.logger.log(JSON.stringify(payload));
  }
}
