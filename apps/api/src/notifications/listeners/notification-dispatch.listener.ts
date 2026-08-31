import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications.service';

/**
 * Subscribes to the SAME `auth.*`/`licensing.*`/`workflow.*` domain events
 * `AuditEventsListener`/`LicensingEventsListener`/`WorkflowEventsListener`
 * already consume (see /CLAUDE.md § Conventions → Notifications → Event ->
 * notification mapping) — no existing emitter changes for this listener to
 * work; `NotificationsService.handleDomainEvent` itself no-ops for any
 * event type not in `@hrm/shared`'s `NOTIFICATION_EVENT_TYPES`, so this
 * class doesn't need per-event-type methods.
 *
 * THE ASYNC BOUNDARY: `@nestjs/event-emitter`'s `emit()` does not await an
 * async listener — it invokes it and moves on. This method is deliberately
 * fire-and-forget (`.catch()`, never `await`ed by the emitter, and this
 * method itself never awaited by its caller) so a slow/failing dispatch
 * can NEVER hold up the request that triggered the original event. Any
 * error here is logged, not re-thrown — the emitting module's request
 * already completed by the time most of this work runs, so there's no
 * response left to fail.
 */
@Injectable()
export class NotificationDispatchListener {
  private readonly logger = new Logger(NotificationDispatchListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent('auth.*')
  handleAuth(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('licensing.*')
  handleLicensing(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('workflow.*')
  handleWorkflow(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('payroll.*')
  handlePayroll(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  private dispatch(payload: { type: string; [key: string]: unknown }): void {
    this.notifications.handleDomainEvent(payload.type, payload).catch((error: unknown) => {
      this.logger.error(`Failed to dispatch notifications for event "${payload.type}": ${String(error)}`);
    });
  }
}
