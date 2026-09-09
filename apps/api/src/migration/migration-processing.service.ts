import { Injectable, Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import type { ImportEntityTypeKey, ImportFileFormatKey } from '@hrm/shared';
import { AuditRecordService } from '../audit/audit-record.service';
import { StorageService } from '../storage/storage.service';
import { OrgStructureCacheService } from '../tenancy/org-structure-cache.service';
import { IMPORT_BATCH_ENTITY_TYPE } from './migration.constants';
import { applyColumnMapping, parseImportFile } from './file-parsing/parse-import-file';
import { ImporterRegistry } from './importers/importer-registry';
import type { StagedRow } from './importers/entity-importer.interface';
import { runImportRow } from './migration-row-runner';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The shared dry-run/commit ENGINE — called by `MigrationProcessor` (the
 * BullMQ worker). See docs/conventions/data-migration.md for the full
 * two-phase lifecycle. Context-less (no `TenantContextService`, no request)
 * — every DB access opens its OWN `withTenantContext` transaction, the same
 * posture `EmployeeImportProcessor`/`LeaveAccrualProcessor` already
 * establish, and for the SAME reason: the actual per-row work
 * (`runImportRow`) needs this identical shape to make dry-run rollback and
 * commit-row-isolation both work.
 */
@Injectable()
export class MigrationProcessingService {
  private readonly logger = new Logger(MigrationProcessingService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly importers: ImporterRegistry,
    private readonly auditRecord: AuditRecordService,
    private readonly orgStructureCache: OrgStructureCacheService,
  ) {}

  async runDryRun(tenantId: string, batchId: string): Promise<void> {
    try {
      const batch = await withTenantContext(tenantId, (tx) => tx.importBatch.findUniqueOrThrow({ where: { id: batchId } }));
      const buffer = await this.downloadFile(batch.fileStorageKey!);
      const rows = parseImportFile(buffer, batch.fileFormat as ImportFileFormatKey);
      const mapping = batch.columnMapping as Record<string, string>;
      const importer = this.importers.get(batch.entityType as ImportEntityTypeKey);

      await withTenantContext(tenantId, (tx) => tx.importRowError.deleteMany({ where: { importBatchId: batchId, phase: 'DRY_RUN' } }));

      const staged: StagedRow[] = [];
      let createCount = 0;
      let updateCount = 0;
      let skipCount = 0;

      for (const row of rows) {
        const mappedRow = applyColumnMapping(row.raw, mapping);
        const result = await runImportRow(tenantId, false, (tx) => importer.processRow(tx, tenantId, batchId, null, mappedRow));
        if (result.ok) {
          staged.push({ rowNumber: row.rowNumber, mappedRow, outcome: result.value });
          if (result.value.status === 'CREATE') createCount++;
          else if (result.value.status === 'UPDATE') updateCount++;
          else skipCount++;
        } else {
          staged.push({ rowNumber: row.rowNumber, mappedRow, outcome: null });
          await this.recordRowError(tenantId, batchId, 'DRY_RUN', row.rowNumber, result.message, mappedRow);
        }
      }

      if (importer.finalize) {
        const extra = await withTenantContext(tenantId, (tx) => importer.finalize!(tx, tenantId, null, false, staged));
        for (const [rowNumber, message] of extra) {
          const stagedRow = staged.find((s) => s.rowNumber === rowNumber);
          await this.recordRowError(tenantId, batchId, 'DRY_RUN', rowNumber, message, stagedRow?.mappedRow ?? {});
        }
      }

      const errorCount = await withTenantContext(tenantId, (tx) =>
        tx.importRowError.count({ where: { importBatchId: batchId, phase: 'DRY_RUN' } }),
      );
      await withTenantContext(tenantId, (tx) =>
        tx.importBatch.update({
          where: { id: batchId },
          data: {
            status: 'DRY_RUN_COMPLETE',
            processedRows: rows.length,
            createCount,
            updateCount,
            skipCount,
            errorCount,
            dryRunCompletedAt: new Date(),
            failureReason: null,
          },
        }),
      );
    } catch (error) {
      await this.markFailed(tenantId, batchId, error);
    }
  }

  async runCommit(tenantId: string, batchId: string): Promise<void> {
    try {
      const batch = await withTenantContext(tenantId, (tx) => tx.importBatch.findUniqueOrThrow({ where: { id: batchId } }));
      if (batch.status !== 'COMMITTING') {
        // Either already committed by a prior successful attempt, or not
        // yet transitioned — the FIRST idempotency layer (see
        // docs/conventions/data-migration.md): a redelivered/duplicate job
        // for an already-terminal batch is a safe no-op.
        this.logger.log(`Skipping commit for batch "${batchId}" — status is "${batch.status}", not COMMITTING.`);
        return;
      }
      if (batch.mode === 'ALL_OR_NOTHING' && batch.errorCount > 0) {
        await withTenantContext(tenantId, (tx) =>
          tx.importBatch.update({
            where: { id: batchId },
            data: { status: 'FAILED', failureReason: 'ALL_OR_NOTHING mode: the last dry run found row errors — commit refused, nothing written.' },
          }),
        );
        return;
      }

      const buffer = await this.downloadFile(batch.fileStorageKey!);
      const rows = parseImportFile(buffer, batch.fileFormat as ImportFileFormatKey);
      const mapping = batch.columnMapping as Record<string, string>;
      const importer = this.importers.get(batch.entityType as ImportEntityTypeKey);

      await withTenantContext(tenantId, (tx) => tx.importRowError.deleteMany({ where: { importBatchId: batchId, phase: 'COMMIT' } }));

      const staged: StagedRow[] = [];
      let createCount = 0;
      let updateCount = 0;
      let skipCount = 0;

      for (const row of rows) {
        const mappedRow = applyColumnMapping(row.raw, mapping);
        const result = await runImportRow(tenantId, true, (tx) => importer.processRow(tx, tenantId, batchId, null, mappedRow));
        if (result.ok) {
          staged.push({ rowNumber: row.rowNumber, mappedRow, outcome: result.value });
          if (result.value.status === 'CREATE') createCount++;
          else if (result.value.status === 'UPDATE') updateCount++;
          else skipCount++;
        } else {
          staged.push({ rowNumber: row.rowNumber, mappedRow, outcome: null });
          await this.recordRowError(tenantId, batchId, 'COMMIT', row.rowNumber, result.message, mappedRow);
        }
      }

      if (importer.finalize) {
        const extra = await withTenantContext(tenantId, (tx) => importer.finalize!(tx, tenantId, null, true, staged));
        for (const [rowNumber, message] of extra) {
          const stagedRow = staged.find((s) => s.rowNumber === rowNumber);
          await this.recordRowError(tenantId, batchId, 'COMMIT', rowNumber, message, stagedRow?.mappedRow ?? {});
        }
      }

      const errorCount = await withTenantContext(tenantId, (tx) =>
        tx.importRowError.count({ where: { importBatchId: batchId, phase: 'COMMIT' } }),
      );
      await withTenantContext(tenantId, (tx) =>
        tx.importBatch.update({
          where: { id: batchId },
          data: {
            status: errorCount > 0 ? 'COMMITTED_WITH_ERRORS' : 'COMMITTED',
            processedRows: rows.length,
            createCount,
            updateCount,
            skipCount,
            errorCount,
            committedAt: new Date(),
            failureReason: null,
          },
        }),
      );

      // Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) —
      // BRANCH is one of only two real write paths onto `Branch` in this
      // codebase (seeding, and this importer — see BranchImporter's own
      // doc comment). A committed BRANCH batch may have created/updated
      // branches, so the tenant's cached branch list (`GET
      // /tenancy/branches`) must not keep serving the pre-import list —
      // bust it now that every row's own transaction has genuinely
      // committed (never during the dry run, which never reaches here).
      if (batch.entityType === 'BRANCH') {
        await this.orgStructureCache.invalidate(tenantId);
      }

      // The "who imported what, when, counts" summary the brief calls for
      // — a domain-event-style write (fresh transaction, never throws),
      // the same posture 0.9's DomainEventAuditListener already documents
      // for itself, since this runs from a context-less worker, not an
      // HTTP request.
      await this.auditRecord.recordForTenant({
        tenantId,
        actor: { userId: batch.initiatedByUserId, platform: !!batch.initiatedByPlatformAdminId },
        action: 'migration.batch_committed',
        entityType: IMPORT_BATCH_ENTITY_TYPE,
        entityId: batchId,
        metadata: {
          entityType: batch.entityType,
          mode: batch.mode,
          createCount,
          updateCount,
          skipCount,
          errorCount,
          initiatedByPlatformAdminId: batch.initiatedByPlatformAdminId,
        },
      });
    } catch (error) {
      await this.markFailed(tenantId, batchId, error);
    }
  }

  private async downloadFile(fileStorageKey: string): Promise<Buffer> {
    const { body } = await this.storage.downloadObject(fileStorageKey);
    return streamToBuffer(body);
  }

  private async recordRowError(
    tenantId: string,
    importBatchId: string,
    phase: 'DRY_RUN' | 'COMMIT',
    rowNumber: number,
    message: string,
    rowData: Record<string, unknown>,
  ): Promise<void> {
    await withTenantContext(tenantId, (tx) =>
      tx.importRowError.create({
        data: { tenantId, importBatchId, phase, rowNumber, message, rowData: rowData as Prisma.InputJsonValue },
      }),
    );
  }

  private async markFailed(tenantId: string, batchId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    this.logger.error(`Import batch "${batchId}" failed: ${message}`);
    try {
      await withTenantContext(tenantId, (tx) =>
        tx.importBatch.update({ where: { id: batchId }, data: { status: 'FAILED', failureReason: message } }),
      );
    } catch (updateError) {
      this.logger.error(`Could not even mark batch "${batchId}" as FAILED: ${String(updateError)}`);
    }
  }
}
