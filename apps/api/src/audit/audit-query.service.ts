import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { AuditLogEntryDto, AuditQueryInput } from '@hrm/shared';

/**
 * Read side of the audit log — backs `GET /audit` (permission-gated on
 * `audit.read`, see AuditController). Every filter is optional; `before`
 * (an ISO timestamp) is the pagination cursor, matching this table's
 * natural `occurredAt DESC` ordering rather than Prisma's built-in
 * `cursor` option, which would need the table's COMPOSITE primary key
 * `(id, occurredAt)` — see /CLAUDE.md § Conventions → Audit log for why
 * that shape exists — and gains nothing a plain `occurredAt < before`
 * filter doesn't already give for a read pattern that's inherently
 * "browse recent history".
 */
@Injectable()
export class AuditQueryService {
  async query(tx: Prisma.TransactionClient, filters: AuditQueryInput): Promise<AuditLogEntryDto[]> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.before ? { occurredAt: { lt: new Date(filters.before) } } : {}),
    };

    const rows = await tx.auditLog.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: filters.take,
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
