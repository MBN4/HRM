import { Injectable, Logger } from '@nestjs/common';
import { prisma, withTenantContext } from '@hrm/db';
import { StorageService } from '../storage/storage.service';
import { IMPORT_BATCH_TERMINAL_STATUSES, IMPORT_FILE_RETENTION_HOURS } from './migration.constants';

/**
 * Purges a TERMINAL batch's uploaded source file once the retention window
 * elapses — see docs/conventions/data-migration.md's "never store raw
 * uploaded PII files longer than needed" note. The SAME cross-tenant
 * discovery / per-tenant-transaction-mutation split
 * `WorkflowEscalationService.sweepOverdueSteps` (0.7) and
 * `TicketSlaService.sweepOverdueTickets` (3.1) already establish for
 * themselves: discover eligible rows across ALL tenants via the owner
 * `prisma` client (cheap, indexed — see the model's own
 * `@@index([tenantId, status, filePurgedAt])`), then delete/patch each one
 * inside a proper `withTenantContext` transaction for its own tenant. NOT
 * wired to a real scheduler — the SAME documented, accepted "manual trigger
 * only" tradeoff 0.7's escalation sweep/1.2's accrual job/3.1's SLA sweep
 * already take; safe to call repeatedly/concurrently (`filePurgedAt: null`
 * in the discovery filter, re-checked before each individual purge).
 */
@Injectable()
export class MigrationPurgeService {
  private readonly logger = new Logger(MigrationPurgeService.name);

  constructor(private readonly storage: StorageService) {}

  async purgeExpiredFiles(): Promise<{ purged: number }> {
    const cutoff = new Date(Date.now() - IMPORT_FILE_RETENTION_HOURS * 60 * 60 * 1000);
    const eligible = await prisma.importBatch.findMany({
      where: {
        status: { in: [...IMPORT_BATCH_TERMINAL_STATUSES] },
        fileStorageKey: { not: null },
        filePurgedAt: null,
        updatedAt: { lt: cutoff },
      },
      select: { id: true, tenantId: true, fileStorageKey: true },
    });

    let purged = 0;
    for (const batch of eligible) {
      try {
        await this.storage.deleteObject(batch.fileStorageKey!);
        await withTenantContext(batch.tenantId, (tx) =>
          tx.importBatch.update({ where: { id: batch.id }, data: { fileStorageKey: null, filePurgedAt: new Date() } }),
        );
        purged++;
      } catch (error) {
        this.logger.error(`Could not purge import batch "${batch.id}"'s file: ${String(error)}`);
      }
    }
    return { purged };
  }
}
