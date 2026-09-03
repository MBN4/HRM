import { Injectable } from '@nestjs/common';
import { Prisma, prisma } from '@hrm/db';
import type { AuditLogEntryDto, AuditQueryInput, PlatformAuditQueryInput } from '@hrm/shared';
import { PlatformAuditRecordService } from './platform-audit-record.service';

export interface PlatformAuditLogEntryDto {
  id: string;
  occurredAt: string;
  platformAdminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetTenantId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

/**
 * The READ side of cross-tenant audit access — the single most sensitive
 * read surface in the system (a platform admin can see any tenant's audit
 * trail), so EVERY call here is itself recorded into `PlatformAuditLog`
 * (see `readPlatformLog`/`readTenantLog` below) — "cross-tenant reads...
 * especially" audited, per this step's brief.
 */
@Injectable()
export class PlatformAuditQueryService {
  constructor(private readonly platformAudit: PlatformAuditRecordService) {}

  async readPlatformLog(actorId: string, filters: PlatformAuditQueryInput): Promise<PlatformAuditLogEntryDto[]> {
    const where: Prisma.PlatformAuditLogWhereInput = {
      ...(filters.targetTenantId ? { targetTenantId: filters.targetTenantId } : {}),
      ...(filters.platformAdminId ? { platformAdminId: filters.platformAdminId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.before ? { occurredAt: { lt: new Date(filters.before) } } : {}),
    };

    const rows = await prisma.platformAuditLog.findMany({ where, orderBy: { occurredAt: 'desc' }, take: filters.take });

    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.audit.platform_log_read',
      entityType: 'PlatformAuditLog',
      entityId: null,
      metadata: { filters },
    });

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      platformAdminId: row.platformAdminId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      targetTenantId: row.targetTenantId,
      before: row.before,
      after: row.after,
      metadata: row.metadata,
    }));
  }

  /**
   * Reads a SPECIFIC tenant's own `audit_log` — via the owner `prisma`
   * client directly (a platform request opens no tenant-scoped
   * transaction to read `audit_log` through the ordinary RLS-scoped path
   * with), the same class of deliberate, narrow cross-tenant read
   * `LicensingAdminService`/`ApiKeyAuthService` already establish for
   * themselves. `FORCE ROW LEVEL SECURITY` on `audit_log` means this
   * owner-client path (and seeding/tests) is the ONLY way to read across
   * tenant boundaries — no normal tenant request gains anything from this
   * existing.
   */
  async readTenantLog(actorId: string, tenantId: string, filters: AuditQueryInput): Promise<AuditLogEntryDto[]> {
    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.before ? { occurredAt: { lt: new Date(filters.before) } } : {}),
    };

    const rows = await prisma.auditLog.findMany({ where, orderBy: { occurredAt: 'desc' }, take: filters.take });

    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.audit.tenant_log_read',
      entityType: 'AuditLog',
      entityId: null,
      targetTenantId: tenantId,
      metadata: { filters },
    });

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actorUserId: row.actorUserId,
      actorPlatform: row.actorPlatform,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      metadata: row.metadata,
    }));
  }
}
