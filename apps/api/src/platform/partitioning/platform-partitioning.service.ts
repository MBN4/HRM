import { Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { prisma, type ArchivedPartition, type PartitionedTableName } from '@hrm/db';
import type { UpdatePartitionedTableConfigInput } from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { StorageService } from '../../storage/storage.service';
import { PartitionArchivalService } from '../../partitioning/partition-archival.service';
import { PartitionMaintenanceService } from '../../partitioning/partition-maintenance.service';
import { PartitionRetentionService } from '../../partitioning/partition-retention.service';
import { PartitionStatusService } from '../../partitioning/partition-status.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

/**
 * The vendor console's surface over the REAL step 5.2 partitioning/archival
 * services (see docs/conventions/partitioning-archival.md) — this service
 * owns no partitioning logic of its own, only permission-appropriate
 * read/write access plus audit, the same "platform layer wraps, never
 * reimplements, the real module" shape `PlatformBillingService`/
 * `PlatformBrandingService` already establish for their own domains.
 */
@Injectable()
export class PlatformPartitioningService {
  constructor(
    private readonly maintenance: PartitionMaintenanceService,
    private readonly archival: PartitionArchivalService,
    private readonly status: PartitionStatusService,
    private readonly retention: PartitionRetentionService,
    private readonly storage: StorageService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
  ) {}

  listConfigs() {
    return this.retention.listConfigs();
  }

  async updateConfig(actorId: string, tableName: PartitionedTableName, input: UpdatePartitionedTableConfigInput) {
    const before = await prisma.partitionedTableConfig.findUnique({ where: { tableName } });
    const after = await this.retention.updateConfig(tableName, input);

    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.partitioning.config_updated',
      entityType: 'PartitionedTableConfig',
      entityId: tableName,
      before,
      after,
    });

    return after;
  }

  getStatus() {
    return this.status.listAllTablesStatus();
  }

  async ensurePartitionsNow(actorId: string) {
    const created = await this.maintenance.ensureAllPartitions();
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.partitioning.ensure_triggered',
      entityType: 'PartitionedTableConfig',
      entityId: null,
      after: { created },
    });
    return created;
  }

  async runArchivalNow(actorId: string) {
    const results = await this.archival.runArchivalSweep();
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.partitioning.archive_triggered',
      entityType: 'ArchivedPartition',
      entityId: null,
      after: { archived: results },
    });
    return results;
  }

  listArchives(tableName?: PartitionedTableName) {
    return prisma.archivedPartition.findMany({
      where: tableName ? { tableName } : undefined,
      orderBy: { archivedAt: 'desc' },
    });
  }

  async getArchiveDownload(id: string): Promise<{ archive: ArchivedPartition; body: Readable; contentType?: string }> {
    const archive = await prisma.archivedPartition.findUnique({ where: { id } });
    if (!archive) {
      throw new NotFoundException(`Archived partition "${id}" was not found.`);
    }
    const { body, contentType } = await this.storage.downloadObject(archive.storageKey);
    return { archive, body, contentType };
  }

  listTenantOverrides(tenantId: string) {
    return this.retention.listTenantOverrides(tenantId);
  }

  async upsertTenantOverride(actorId: string, tenantId: string, tableName: PartitionedTableName, retentionMonths: number) {
    const existing = await prisma.tenantRetentionOverride.findUnique({ where: { tenantId_tableName: { tenantId, tableName } } });
    const override = await this.retention.upsertTenantOverride(tenantId, tableName, retentionMonths);

    await this.recordTenantAudit(actorId, tenantId, 'platform.partitioning.tenant_retention_override_set', existing, override);
    return override;
  }

  async removeTenantOverride(actorId: string, tenantId: string, tableName: PartitionedTableName): Promise<void> {
    const existing = await prisma.tenantRetentionOverride.findUnique({ where: { tenantId_tableName: { tenantId, tableName } } });
    await this.retention.removeTenantOverride(tenantId, tableName);
    await this.recordTenantAudit(actorId, tenantId, 'platform.partitioning.tenant_retention_override_removed', existing, null);
  }

  /**
   * The SAME dual-audit shape `PlatformTenantService.recordTenantAudit`
   * already establishes: a tenant-targeted action lands in BOTH the
   * target tenant's own `audit_log` (`actorPlatform: true`) and the
   * platform's own consolidated `PlatformAuditLog`.
   */
  private async recordTenantAudit(actorId: string, tenantId: string, action: string, before: unknown, after: unknown): Promise<void> {
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action,
      entityType: 'TenantRetentionOverride',
      entityId: tenantId,
      before,
      after,
      metadata: { platformAdminId: actorId },
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action,
      entityType: 'TenantRetentionOverride',
      entityId: tenantId,
      targetTenantId: tenantId,
      before,
      after,
    });
  }
}
