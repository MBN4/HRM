import { Injectable, Logger } from '@nestjs/common';
import { Prisma, prisma } from '@hrm/db';
import { redactSensitiveFields } from '@hrm/shared';

export interface RecordPlatformAuditInput {
  platformAdminId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  targetTenantId?: string | null;
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
 * The platform's own cross-tenant / no-single-tenant-target audit trail —
 * see schema.prisma's `PlatformAuditLog` doc comment and
 * docs/conventions/vendor-console.md. EVERY platform action goes through
 * here — login, MFA enrollment, tenant lifecycle, license issue/revoke,
 * country-pack authoring/versioning/activation, usage/audit reads,
 * impersonation start/end. Tenant-targeted mutations ALSO record into that
 * tenant's own `audit_log` via the EXISTING `AuditRecordService.recordForTenant`
 * (`actorPlatform: true`) — this service does not replace that, it exists
 * for actions `audit_log` structurally cannot represent (no tenant to
 * attach to) and as the vendor's own consolidated cross-tenant view.
 *
 * Queries the owner `prisma` client directly — `PlatformAuditLog` isn't
 * tenant-scoped (see schema.prisma), so there is no `withTenantContext` to
 * open in the first place, the same reasoning `LicensingAdminService`
 * already documents for its own writes.
 */
@Injectable()
export class PlatformAuditRecordService {
  private readonly logger = new Logger(PlatformAuditRecordService.name);

  async record(input: RecordPlatformAuditInput): Promise<void> {
    try {
      await prisma.platformAuditLog.create({
        data: {
          platformAdminId: input.platformAdminId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          targetTenantId: input.targetTenantId ?? null,
          before: toJsonInput(input.before),
          after: toJsonInput(input.after),
          metadata: toJsonInput(input.metadata),
        },
      });
    } catch (error) {
      // Same "an audit-sink failure must never look like the original
      // action failed" posture AuditRecordService.recordForTenant already
      // documents for itself — the mutation already happened and already
      // returned a response.
      this.logger.error(`Failed to write platform audit entry for action "${input.action}": ${String(error)}`);
    }
  }
}
