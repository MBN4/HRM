import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { ImportBatch, ImportRowError, Prisma } from '@hrm/db';
import {
  assertColumnMappingComplete,
  CreateImportBatchMetadataInput,
  IMPORT_ENTITY_FIELDS,
  ImportEntityTypeKey,
} from '@hrm/shared';
import { StorageService } from '../storage/storage.service';
import { MIGRATION_QUEUE } from '../queue/queue.constants';
import { parseImportFile } from './file-parsing/parse-import-file';

export interface MigrationJobData {
  tenantId: string;
  batchId: string;
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

export interface ImportInitiator {
  userId: string | null;
  platformAdminId: string | null;
}

/**
 * CRUD + the BullMQ producer side for `ImportBatch` — mirrors 1.1's
 * `EmployeeImportService` shape exactly (see docs/conventions/employee.md):
 * create the tracking row, store the uploaded file, enqueue a job, return
 * immediately. See docs/conventions/data-migration.md for the full
 * dry-run/commit lifecycle this feeds.
 */
@Injectable()
export class ImportBatchService {
  constructor(
    @InjectQueue(MIGRATION_QUEUE) private readonly queue: Queue<MigrationJobData>,
    private readonly storage: StorageService,
  ) {}

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    initiator: ImportInitiator,
    metadata: CreateImportBatchMetadataInput,
    file: { buffer: Buffer; fileName: string },
  ): Promise<ImportBatch> {
    const missing = assertColumnMappingComplete(metadata.entityType, metadata.columnMapping);
    if (missing.length > 0) {
      throw new BadRequestException(
        `The column mapping is missing required field(s): ${missing.join(', ')}.`,
      );
    }
    const unknownKeys = Object.keys(metadata.columnMapping).filter(
      (key) => !IMPORT_ENTITY_FIELDS[metadata.entityType].some((f) => f.key === key),
    );
    if (unknownKeys.length > 0) {
      throw new BadRequestException(`Unknown column mapping field(s) for ${metadata.entityType}: ${unknownKeys.join(', ')}.`);
    }

    let totalRows: number;
    try {
      totalRows = parseImportFile(file.buffer, metadata.fileFormat).length;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Could not parse the uploaded file.');
    }
    if (totalRows === 0) {
      throw new BadRequestException('The uploaded file has no data rows.');
    }

    const batch = await tx.importBatch.create({
      data: {
        tenantId,
        entityType: metadata.entityType,
        mode: metadata.mode,
        status: 'UPLOADED',
        fileName: file.fileName,
        fileFormat: metadata.fileFormat,
        columnMapping: metadata.columnMapping,
        columnMappingTemplateId: metadata.columnMappingTemplateId ?? null,
        totalRows,
        initiatedByUserId: initiator.userId,
        initiatedByPlatformAdminId: initiator.platformAdminId,
      },
    });

    const fileStorageKey = `migration/${tenantId}/${batch.id}/${file.fileName}`;
    await this.storage.uploadObject({
      key: fileStorageKey,
      body: file.buffer,
      contentType: metadata.fileFormat === 'CSV' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    return tx.importBatch.update({ where: { id: batch.id }, data: { fileStorageKey } });
  }

  async submitDryRun(tx: Prisma.TransactionClient, tenantId: string, batchId: string): Promise<ImportBatch> {
    const batch = await this.requireBatch(tx, batchId);
    if (batch.status === 'VALIDATING' || batch.status === 'COMMITTING') {
      throw new ConflictException(`This batch is already ${batch.status.toLowerCase()}.`);
    }
    if (!batch.fileStorageKey) {
      throw new BadRequestException('This batch\'s uploaded file has been purged and can no longer be validated.');
    }
    const updated = await tx.importBatch.update({ where: { id: batchId }, data: { status: 'VALIDATING' } });
    await this.queue.add('validate', { tenantId, batchId }, JOB_OPTIONS);
    return updated;
  }

  async submitCommit(tx: Prisma.TransactionClient, tenantId: string, batchId: string): Promise<ImportBatch> {
    const batch = await this.requireBatch(tx, batchId);
    if (batch.status !== 'DRY_RUN_COMPLETE') {
      throw new ConflictException(
        `A batch can only be committed right after a successful dry run (current status: ${batch.status}).`,
      );
    }
    if (!batch.fileStorageKey) {
      throw new BadRequestException('This batch\'s uploaded file has been purged and can no longer be committed.');
    }
    const updated = await tx.importBatch.update({ where: { id: batchId }, data: { status: 'COMMITTING' } });
    await this.queue.add('commit', { tenantId, batchId }, JOB_OPTIONS);
    return updated;
  }

  async requireBatch(tx: Prisma.TransactionClient, id: string): Promise<ImportBatch> {
    const row = await tx.importBatch.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Import batch "${id}" was not found.`);
    return row;
  }

  async list(tx: Prisma.TransactionClient, filters: { entityType?: ImportEntityTypeKey; status?: string }): Promise<ImportBatch[]> {
    return tx.importBatch.findMany({
      where: { entityType: filters.entityType, status: filters.status as never },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async listRowErrors(tx: Prisma.TransactionClient, batchId: string, phase?: string): Promise<ImportRowError[]> {
    await this.requireBatch(tx, batchId);
    return tx.importRowError.findMany({
      where: { importBatchId: batchId, phase },
      orderBy: { rowNumber: 'asc' },
      take: 5000,
    });
  }

  async buildErrorReportCsv(tx: Prisma.TransactionClient, batchId: string): Promise<string> {
    const batch = await this.requireBatch(tx, batchId);
    const errors = await this.listRowErrors(tx, batchId);
    const fieldKeys = IMPORT_ENTITY_FIELDS[batch.entityType as ImportEntityTypeKey].map((f) => f.key);
    const header = ['rowNumber', 'phase', 'message', ...fieldKeys];
    const lines = [header.map(csvCell).join(',')];
    for (const error of errors) {
      const rowData = (error.rowData ?? {}) as Record<string, unknown>;
      const cells = [String(error.rowNumber), error.phase, error.message, ...fieldKeys.map((k) => String(rowData[k] ?? ''))];
      lines.push(cells.map(csvCell).join(','));
    }
    return lines.join('\n');
  }
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
