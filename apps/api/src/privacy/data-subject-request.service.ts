import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { withTenantContext, type DataSubjectRequest, type Prisma } from '@hrm/db';
import type { CreateDataSubjectRequestInput, ListDataSubjectRequestsQuery } from '@hrm/shared';
import { AuditRecordService } from '../audit/audit-record.service';
import { StorageService } from '../storage/storage.service';
import { PRIVACY_QUEUE } from '../queue/queue.constants';
import { DATA_SUBJECT_REQUEST_ENTITY_TYPE } from './privacy.constants';
import { DataExportService } from './data-export.service';
import { PrivacyErasureService, type ErasureSummary } from './privacy-erasure.service';

export interface PrivacyJobData {
  tenantId: string;
  requestId: string;
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * Data-subject request lifecycle (step 6.1) — see
 * docs/conventions/privacy-residency.md. Mirrors the migration toolkit's own
 * "submit -> enqueue -> poll status" shape (data-migration.md): a request is
 * created `PENDING`, a BullMQ job (`PrivacyProcessor`) does the actual
 * cross-module aggregation/erasure work, and the caller polls
 * `GET /privacy/requests/:id` for `PROCESSING -> COMPLETED/FAILED`. Kept
 * asynchronous, not run inline in the HTTP handler, for the SAME reason
 * every other heavy multi-table operation in this codebase already is
 * (employee import, migration batches, payroll runs, statutory reports):
 * genuine cross-module I/O (dozens of tables, object storage) does not
 * belong inside one request/response cycle.
 */
@Injectable()
export class DataSubjectRequestService {
  private readonly logger = new Logger(DataSubjectRequestService.name);

  constructor(
    @InjectQueue(PRIVACY_QUEUE) private readonly queue: Queue<PrivacyJobData>,
    private readonly exportService: DataExportService,
    private readonly erasureService: PrivacyErasureService,
    private readonly auditRecord: AuditRecordService,
    private readonly storage: StorageService,
  ) {}

  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreateDataSubjectRequestInput,
    actor: { userId: string | null; platformAdminId?: string | null },
  ): Promise<DataSubjectRequest> {
    const request = await tx.dataSubjectRequest.create({
      data: {
        tenantId,
        requestType: input.requestType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reason: input.reason,
        requestedByUserId: actor.userId,
        initiatedByPlatformAdminId: actor.platformAdminId ?? null,
      },
    });

    await this.queue.add(input.requestType === 'EXPORT' ? 'export' : 'erasure', { tenantId, requestId: request.id }, JOB_OPTIONS);
    return request;
  }

  list(tx: Prisma.TransactionClient, tenantId: string, query: ListDataSubjectRequestsQuery): Promise<DataSubjectRequest[]> {
    return tx.dataSubjectRequest.findMany({
      where: { tenantId, status: query.status, subjectType: query.subjectType },
      orderBy: { createdAt: 'desc' },
      take: query.take,
    });
  }

  async get(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<DataSubjectRequest> {
    const request = await tx.dataSubjectRequest.findFirst({ where: { tenantId, id } });
    if (!request) {
      throw new NotFoundException(`Data subject request "${id}" was not found.`);
    }
    return request;
  }

  async getExportManifest(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<{ storageKey: string }> {
    const request = await this.get(tx, tenantId, id);
    if (request.requestType !== 'EXPORT' || request.status !== 'COMPLETED' || !request.resultStorageKey) {
      throw new NotFoundException('This export is not yet available.');
    }
    return { storageKey: request.resultStorageKey };
  }

  /** Called by `PrivacyProcessor` — context-less, opens its own `withTenantContext` transactions, the same posture every BullMQ processing service in this codebase already takes. */
  async processExport(tenantId: string, requestId: string): Promise<void> {
    await this.markProcessing(tenantId, requestId);
    try {
      const request = await withTenantContext(tenantId, (tx) => tx.dataSubjectRequest.findFirstOrThrow({ where: { tenantId, id: requestId } }));
      const result = await this.exportService.run(tenantId, requestId, request.subjectType as never, request.subjectId);
      await withTenantContext(tenantId, (tx) =>
        tx.dataSubjectRequest.update({
          where: { id: requestId },
          data: { status: 'COMPLETED', resultStorageKey: result.storageKey, completedAt: new Date() },
        }),
      );
      await this.recordCompletionAudit(tenantId, requestId, 'privacy.export_completed', { fileCount: result.fileKeys.length });
    } catch (error) {
      await this.markFailed(tenantId, requestId, error);
    }
  }

  async processErasure(tenantId: string, requestId: string): Promise<void> {
    await this.markProcessing(tenantId, requestId);
    try {
      const request = await withTenantContext(tenantId, (tx) => tx.dataSubjectRequest.findFirstOrThrow({ where: { tenantId, id: requestId } }));
      const summary: ErasureSummary = await this.erasureService.run(tenantId, request.subjectType as never, request.subjectId);
      await withTenantContext(tenantId, (tx) =>
        tx.dataSubjectRequest.update({
          where: { id: requestId },
          data: { status: 'COMPLETED', erasureSummary: summary as never, completedAt: new Date() },
        }),
      );
      await this.recordCompletionAudit(tenantId, requestId, 'privacy.erasure_completed', summary as never);
    } catch (error) {
      await this.markFailed(tenantId, requestId, error);
    }
  }

  private async markProcessing(tenantId: string, requestId: string): Promise<void> {
    await withTenantContext(tenantId, (tx) =>
      tx.dataSubjectRequest.update({ where: { id: requestId }, data: { status: 'PROCESSING' } }),
    );
  }

  private async markFailed(tenantId: string, requestId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Data subject request ${requestId} (tenant ${tenantId}) failed: ${message}`);
    await withTenantContext(tenantId, (tx) =>
      tx.dataSubjectRequest.update({ where: { id: requestId }, data: { status: 'FAILED', failureReason: message } }),
    ).catch(() => undefined);
  }

  private async recordCompletionAudit(tenantId: string, requestId: string, action: string, metadata: unknown): Promise<void> {
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: false },
      action,
      entityType: DATA_SUBJECT_REQUEST_ENTITY_TYPE,
      entityId: requestId,
      metadata,
    });
  }

  /** Used by `RetentionEnforcementService` — creates an already-terminal, system-initiated request row purely as an auditable record of what the scheduled job did, then runs the SAME erasure engine synchronously (the sweep itself already runs off-request, in a scheduled job). */
  async recordSystemErasure(tenantId: string, subjectType: 'EMPLOYEE' | 'CANDIDATE', subjectId: string, reason: string): Promise<void> {
    const summary = await this.erasureService.run(tenantId, subjectType, subjectId);
    await withTenantContext(tenantId, (tx) =>
      tx.dataSubjectRequest.create({
        data: {
          tenantId,
          requestType: 'ERASURE',
          subjectType,
          subjectId,
          reason,
          systemInitiated: true,
          status: 'COMPLETED',
          erasureSummary: summary as never,
          completedAt: new Date(),
        },
      }),
    );
    await this.recordCompletionAudit(tenantId, subjectId, 'privacy.retention_erasure_completed', summary as never);
  }

  async downloadExportManifest(storageKey: string) {
    return this.storage.downloadObject(storageKey);
  }
}
