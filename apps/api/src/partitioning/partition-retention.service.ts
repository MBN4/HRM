import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma, type PartitionedTableConfig, type PartitionedTableName, type TenantRetentionOverride } from '@hrm/db';

export interface UpdatePartitionedTableConfigInput {
  lookaheadMonths?: number;
  retentionMonths?: number;
  archiveEnabled?: boolean;
}

/**
 * Platform default retention/lookahead config, plus the Phase 6.1
 * GDPR/data-residency SEAM this step is asked to provide (see
 * docs/conventions/partitioning-archival.md § Retention & archival): a
 * tenant-specific `TenantRetentionOverride` can be set and read back today,
 * but it is INFORMATIONAL only — `PartitionArchivalService`'s actual
 * archival-eligibility decision reads only the PLATFORM DEFAULT
 * (`PartitionedTableConfig`), never a tenant override, because a single
 * partition holds every tenant's rows for that date range — there is no
 * such thing as "archive this partition for tenant A but not tenant B."
 * Honestly documented, not silently glossed over: a real per-tenant
 * shorter-retention/right-to-erasure purge is future (Phase 6.1) work that
 * would need a genuinely different, row-level mechanism.
 */
@Injectable()
export class PartitionRetentionService {
  async listConfigs(): Promise<PartitionedTableConfig[]> {
    return prisma.partitionedTableConfig.findMany({ orderBy: { tableName: 'asc' } });
  }

  async updateConfig(tableName: PartitionedTableName, input: UpdatePartitionedTableConfigInput): Promise<PartitionedTableConfig> {
    return prisma.partitionedTableConfig.update({ where: { tableName }, data: input });
  }

  async listTenantOverrides(tenantId: string): Promise<TenantRetentionOverride[]> {
    await this.requireTenant(tenantId);
    return prisma.tenantRetentionOverride.findMany({ where: { tenantId }, orderBy: { tableName: 'asc' } });
  }

  async upsertTenantOverride(tenantId: string, tableName: PartitionedTableName, retentionMonths: number): Promise<TenantRetentionOverride> {
    await this.requireTenant(tenantId);
    return prisma.tenantRetentionOverride.upsert({
      where: { tenantId_tableName: { tenantId, tableName } },
      create: { tenantId, tableName, retentionMonths },
      update: { retentionMonths },
    });
  }

  async removeTenantOverride(tenantId: string, tableName: PartitionedTableName): Promise<void> {
    await this.requireTenant(tenantId);
    await prisma.tenantRetentionOverride.deleteMany({ where: { tenantId, tableName } });
  }

  private async requireTenant(tenantId: string): Promise<void> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${tenantId}" was not found.`);
    }
  }
}
