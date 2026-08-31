import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditRecordService } from '../audit-record.service';

interface DomainEventPayload {
  type: string;
  tenantId: string;
  [key: string]: unknown;
}

/** Checked in order — the first of these present (and a string) on a payload becomes the audit row's `entityId`. */
const ENTITY_ID_FIELDS = [
  'instanceId',
  'licenseId',
  'deliveryId',
  'notificationId',
  'userId',
  'flagKey',
  'cycleId',
  'assignmentId',
  'offerId',
  'taskId',
] as const;

/**
 * These licensing event types are ALWAYS emitted from `LicensingAdminService`
 * (see /CLAUDE.md § Conventions → Platform context), i.e. from an
 * unauthenticated `@PlatformRoute()` with no per-user actor to attach — the
 * one deliberate, documented exception to this listener's otherwise fully
 * generic entity/actor derivation.
 */
const PLATFORM_ORIGINATED_EVENT_TYPES = new Set(['licensing.issued', 'licensing.revoked', 'licensing.flag_override_set']);

/**
 * Replaces the three placeholder domain-event loggers (`auth`'s
 * `AuditEventsListener`, `licensing`'s `LicensingEventsListener`,
 * `workflow`'s `WorkflowEventsListener`) with real persistence into
 * `audit_log` — the wiring point each of their own doc comments already
 * promised 0.9 would land at (their classes/registrations are removed by
 * this step, superseded by this one consolidated listener). Also
 * subscribes to `notification.*`: nothing currently emits under that
 * namespace, but the notifications hub is explicitly listed alongside
 * auth/licensing/workflow as a source this step should wire in — this
 * future-proofs the sink for free the moment a `notification.*` event
 * exists, at zero cost today since the subscription simply never fires.
 *
 * `entityType`/`entityId` are derived GENERICALLY, not via a per-event
 * switch statement — contrast `NotificationRecipientResolverService`
 * (0.8), which genuinely needs one because "who receives this" has no
 * uniform answer across event types. Audit's job is just "record that
 * this happened", so a namespace-derived entity type (`"workflow.approved"`
 * -> `"Workflow"`) plus the first present of a short list of common id
 * fields is sufficient and doesn't grow a maintenance burden with every
 * future event type the way a switch statement would.
 *
 * Every write goes through `AuditRecordService.recordForTenant`, which
 * opens its OWN fresh transaction rather than reusing the emitting
 * request's — see that method's doc comment for why (the same
 * asynchronous-dispatch timing gap 0.8's `NotificationDispatchListener`
 * documents as "THE RACE"; this listener is fire-and-forget for the exact
 * same reason theirs is).
 */
@Injectable()
export class DomainEventAuditListener {
  private readonly logger = new Logger(DomainEventAuditListener.name);

  constructor(private readonly auditRecord: AuditRecordService) {}

  @OnEvent('auth.*')
  handleAuth(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('licensing.*')
  handleLicensing(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('workflow.*')
  handleWorkflow(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('notification.*')
  handleNotification(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('payroll.*')
  handlePayroll(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('performance.*')
  handlePerformance(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('recruitment.*')
  handleRecruitment(payload: DomainEventPayload): void {
    this.record(payload);
  }

  @OnEvent('checklist.*')
  handleChecklist(payload: DomainEventPayload): void {
    this.record(payload);
  }

  private record(payload: DomainEventPayload): void {
    const [namespace] = payload.type.split('.');
    const entityType = namespace.charAt(0).toUpperCase() + namespace.slice(1);
    const entityId =
      ENTITY_ID_FIELDS.map((field) => payload[field]).find((value): value is string => typeof value === 'string') ?? null;

    this.auditRecord
      .recordForTenant({
        tenantId: payload.tenantId,
        actor: {
          userId: typeof payload.userId === 'string' ? payload.userId : null,
          platform: PLATFORM_ORIGINATED_EVENT_TYPES.has(payload.type),
        },
        action: payload.type,
        entityType,
        entityId,
        after: payload,
      })
      .catch((error: unknown) => {
        this.logger.error(`Failed to audit domain event "${payload.type}": ${String(error)}`);
      });
  }
}
