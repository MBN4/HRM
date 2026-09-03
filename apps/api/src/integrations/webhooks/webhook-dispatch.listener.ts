import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebhookDispatchService } from './webhook-dispatch.service';

/**
 * Subscribes to the EXACT SAME wildcard namespaces
 * `NotificationDispatchListener` already does (see `@hrm/shared`'s
 * `WEBHOOK_EVENT_NAMESPACES` for the data-level list this mirrors) — no
 * existing emitter changes needed for this to work;
 * `WebhookDispatchService.handleDomainEvent` no-ops for any event type not
 * in `WEBHOOK_EVENT_TYPES`. Same fire-and-forget posture as
 * `NotificationDispatchListener`: `@nestjs/event-emitter`'s `emit()` never
 * awaits a listener, so a slow/failing dispatch can never hold up the
 * request that triggered the original event.
 */
@Injectable()
export class WebhookDispatchListener {
  private readonly logger = new Logger(WebhookDispatchListener.name);

  constructor(private readonly webhooks: WebhookDispatchService) {}

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

  @OnEvent('performance.*')
  handlePerformance(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('recruitment.*')
  handleRecruitment(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('checklist.*')
  handleChecklist(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('helpdesk.*')
  handleHelpdesk(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  @OnEvent('lms.*')
  handleLms(payload: { type: string; [key: string]: unknown }): void {
    this.dispatch(payload);
  }

  private dispatch(payload: { type: string; [key: string]: unknown }): void {
    this.webhooks.handleDomainEvent(payload.type, payload).catch((error: unknown) => {
      this.logger.error(`Failed to dispatch webhooks for event "${payload.type}": ${String(error)}`);
    });
  }
}
