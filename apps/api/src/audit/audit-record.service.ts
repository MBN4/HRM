import { Injectable, Logger } from '@nestjs/common';
import { Prisma, withTenantContext } from '@hrm/db';
import { redactSensitiveFields } from '@hrm/shared';

export interface AuditActor {
  userId: string | null;
  platform: boolean;
}

export interface RecordAuditInput {
  tenantId: string;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) {
    return Prisma.DbNull;
  }
  return redactSensitiveFields(value) as Prisma.InputJsonValue;
}

/**
 * The one place `audit_log` rows are ever written — both capture paths
 * (`AuditInterceptor` for HTTP mutations, `DomainEventAuditListener` for
 * `auth.*`/`licensing.*`/`workflow.*`/`notification.*` events) go through
 * this service, so redaction (`redactSensitiveFields`, applied to EVERY
 * `before`/`after`/`metadata` payload, no exceptions) happens in exactly
 * one place. See /CLAUDE.md § Conventions → Audit log.
 */
@Injectable()
export class AuditRecordService {
  private readonly logger = new Logger(AuditRecordService.name);

  /**
   * Writes within the CALLER's already-open request transaction. Used by
   * `AuditInterceptor` so the audit row's fate is tied to the mutation's
   * own transaction — a rollback rolls back the audit entry too, which is
   * correct: if the mutation didn't happen, nothing should claim it did.
   */
  async recordWithinTransaction(tx: Prisma.TransactionClient, input: RecordAuditInput): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(input) });
  }

  /**
   * Writes in a FRESH transaction scoped to `input.tenantId`, for callers
   * with no open request transaction to reuse — domain events, which may
   * run asynchronously after the emitting request's own transaction has
   * already committed (same class of timing gap documented as "THE RACE"
   * in /CLAUDE.md § Conventions → Notifications). Never throws: an
   * audit-sink failure must not look like the ORIGINAL action failed — the
   * mutation this event describes already happened and already returned a
   * response to its caller — so a failure here is logged, not propagated.
   */
  async recordForTenant(input: RecordAuditInput): Promise<void> {
    try {
      await withTenantContext(input.tenantId, (tx) => tx.auditLog.create({ data: this.toRow(input) }));
    } catch (error) {
      this.logger.error(`Failed to write audit entry for action "${input.action}": ${String(error)}`);
    }
  }

  private toRow(input: RecordAuditInput): Prisma.AuditLogUncheckedCreateInput {
    return {
      tenantId: input.tenantId,
      actorUserId: input.actor.userId,
      actorPlatform: input.actor.platform,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: toJsonInput(input.before),
      after: toJsonInput(input.after),
      metadata: toJsonInput(input.metadata),
    };
  }
}
