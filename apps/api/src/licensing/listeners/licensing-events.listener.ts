import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { LicensingEventPayload } from '../licensing-events';

/**
 * Placeholder consumer for every `licensing.*` domain event (see
 * licensing-events.ts) — logs them structured, same pattern and same
 * eventual replacement plan as `auth/listeners/audit-events.listener.ts`.
 * Requires `EventEmitterModule.forRoot({ wildcard: true })` (already set
 * in app.module.ts for the auth listener) for the `'licensing.*'` pattern
 * to match.
 */
@Injectable()
export class LicensingEventsListener {
  private readonly logger = new Logger('AuditEvent');

  @OnEvent('licensing.*')
  handleLicensingEvent(payload: LicensingEventPayload): void {
    this.logger.log(JSON.stringify(payload));
  }
}
