import { Injectable } from '@nestjs/common';
import type { ImportBatch, ImportRowError } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import type { CreateImportBatchMetadataInput, ImportEntityTypeKey } from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { ImportBatchService } from '../../migration/import-batch.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

/**
 * The vendor-console onboarding surface's business logic — see
 * docs/conventions/vendor-console.md and docs/conventions/data-migration.md.
 * Reuses `ImportBatchService` UNCHANGED (it takes `tx`/`tenantId`
 * explicitly, exactly so this could reuse it — see that file's own doc
 * comment; mapping-template save/reuse is deliberately tenant-self-serve
 * only, not exposed on this platform surface — a vendor admin supplies the
 * column mapping directly, the same "functional over fancy" raw-JSON
 * posture vendor-console.md already documents for country-pack authoring):
 * a batch a platform admin runs on a tenant's behalf goes through the
 * IDENTICAL create/validate/commit/report
 * code path a tenant's own `MigrationController` uses, opened via
 * `withTenantContext` (a proper, RLS-enforced tenant-scoped transaction,
 * the SAME pattern `AuditRecordService.recordForTenant`/
 * `DomainEventAuditListener` already establish for writing into a tenant's
 * own tables from outside its own request context) rather than the owner
 * `prisma` client — RLS still applies even though the actor is a platform
 * admin, defense-in-depth per this project's "no single layer of security
 * trusted alone" posture.
 *
 * Every write is DUAL-audited exactly like 4.1's impersonation/4.2/4.3's
 * own oversight actions: the platform's own consolidated
 * `PlatformAuditLog` AND (via the EXISTING `AuditRecordService.recordForTenant`,
 * `actorPlatform: true`) the TARGET TENANT's own `audit_log` — so a
 * tenant's `TENANT_ADMIN` can see for themselves, via their own ordinary
 * `GET /audit`, that a vendor admin ran an import on their behalf. The
 * commit's own completion summary is already tagged this way for free by
 * `MigrationProcessingService.runCommit` itself, since `ImportBatch.
 * initiatedByPlatformAdminId` is set at creation — no duplicate write here.
 */
@Injectable()
export class PlatformMigrationService {
  constructor(
    private readonly batches: ImportBatchService,
    private readonly platformAudit: PlatformAuditRecordService,
    private readonly tenantAudit: AuditRecordService,
  ) {}

  async createBatch(
    platformAdminId: string,
    tenantId: string,
    metadata: CreateImportBatchMetadataInput,
    file: { buffer: Buffer; fileName: string },
  ): Promise<ImportBatch> {
    const batch = await withTenantContext(tenantId, (tx) =>
      this.batches.create(tx, tenantId, { userId: null, platformAdminId }, metadata, file),
    );
    await this.platformAudit.record({
      platformAdminId,
      action: 'platform.migration.batch_created',
      entityType: 'ImportBatch',
      entityId: batch.id,
      targetTenantId: tenantId,
      metadata: { entityType: metadata.entityType, fileName: file.fileName, mode: metadata.mode },
    });
    await this.tenantAudit.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action: 'migration.batch_created',
      entityType: 'ImportBatch',
      entityId: batch.id,
      metadata: { initiatedByPlatformAdminId: platformAdminId, entityType: metadata.entityType },
    });
    return batch;
  }

  list(tenantId: string, filters: { entityType?: ImportEntityTypeKey; status?: string }): Promise<ImportBatch[]> {
    return withTenantContext(tenantId, (tx) => this.batches.list(tx, filters));
  }

  getOne(tenantId: string, id: string): Promise<ImportBatch> {
    return withTenantContext(tenantId, (tx) => this.batches.requireBatch(tx, id));
  }

  async validate(platformAdminId: string, tenantId: string, id: string): Promise<ImportBatch> {
    const batch = await withTenantContext(tenantId, (tx) => this.batches.submitDryRun(tx, tenantId, id));
    await this.platformAudit.record({
      platformAdminId,
      action: 'platform.migration.batch_validated',
      entityType: 'ImportBatch',
      entityId: id,
      targetTenantId: tenantId,
    });
    return batch;
  }

  async commit(platformAdminId: string, tenantId: string, id: string): Promise<ImportBatch> {
    const batch = await withTenantContext(tenantId, (tx) => this.batches.submitCommit(tx, tenantId, id));
    await this.platformAudit.record({
      platformAdminId,
      action: 'platform.migration.batch_commit_started',
      entityType: 'ImportBatch',
      entityId: id,
      targetTenantId: tenantId,
    });
    return batch;
  }

  errors(tenantId: string, id: string, phase?: string): Promise<ImportRowError[]> {
    return withTenantContext(tenantId, (tx) => this.batches.listRowErrors(tx, id, phase));
  }

  async report(platformAdminId: string, tenantId: string, id: string): Promise<string> {
    const csv = await withTenantContext(tenantId, (tx) => this.batches.buildErrorReportCsv(tx, id));
    await this.platformAudit.record({
      platformAdminId,
      action: 'platform.migration.error_report_read',
      entityType: 'ImportBatch',
      entityId: id,
      targetTenantId: tenantId,
    });
    return csv;
  }
}
