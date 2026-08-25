import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { WorkflowEventPayload } from '../workflow-events';

/**
 * Placeholder consumer for every `workflow.*` domain event (see
 * workflow-events.ts) — logs them structured, same pattern and same
 * eventual replacement plan as `AuditEventsListener`/
 * `LicensingEventsListener`. Requires
 * `EventEmitterModule.forRoot({ wildcard: true })` (already set in
 * app.module.ts) for the `'workflow.*'` pattern to match.
 */
@Injectable()
export class WorkflowEventsListener {
  private readonly logger = new Logger('AuditEvent');

  @OnEvent('workflow.*')
  handleWorkflowEvent(payload: WorkflowEventPayload): void {
    this.logger.log(JSON.stringify(payload));
  }
}
