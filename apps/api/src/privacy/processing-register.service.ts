import { Injectable } from '@nestjs/common';
import type { Prisma, TenantDataRetentionOverride } from '@hrm/db';
import { AUTO_ENFORCEABLE_RETENTION_CATEGORIES, type DataCategoryKey } from '@hrm/shared';

export interface EffectiveRetentionPolicy {
  category: DataCategoryKey;
  retentionMonths: number;
  action: string;
  legalBasisNote: string | null;
  tenantOverrideApplied: boolean;
  /** Whether `RetentionEnforcementService`'s scheduled sweep actually acts on this category automatically, vs. it being RETAIN_LEGAL-by-default or on-demand-request-only — see docs/conventions/privacy-residency.md. */
  autoEnforced: boolean;
}

/**
 * The tenant-facing read side of the Record of Processing Activities (ROPA)
 * + sub-processor disclosure + effective retention policy — see
 * docs/conventions/privacy-residency.md. All three underlying tables
 * (`DataProcessingRegisterEntry`/`SubProcessorRecord`/`DataRetentionPolicy`)
 * are platform-authored, read-only from the tenant side (`hrm_app` holds
 * SELECT only — see the enable-RLS migration), the SAME "one shared
 * catalog, read live" posture `CountryPack` already establishes for itself.
 */
@Injectable()
export class ProcessingRegisterService {
  listRegister(tx: Prisma.TransactionClient) {
    return tx.dataProcessingRegisterEntry.findMany({ orderBy: { category: 'asc' } });
  }

  listSubProcessors(tx: Prisma.TransactionClient) {
    return tx.subProcessorRecord.findMany({ orderBy: { name: 'asc' } });
  }

  async effectiveRetentionPolicies(tx: Prisma.TransactionClient, tenantId: string): Promise<EffectiveRetentionPolicy[]> {
    const [defaults, overrides] = await Promise.all([
      tx.dataRetentionPolicy.findMany({ orderBy: { category: 'asc' } }),
      tx.tenantDataRetentionOverride.findMany({ where: { tenantId } }),
    ]);
    const overrideByCategory = new Map(overrides.map((o) => [o.category, o]));

    return defaults.map((policy) => {
      const override = overrideByCategory.get(policy.category);
      return {
        category: policy.category,
        retentionMonths: override?.retentionMonths ?? policy.retentionMonths,
        action: policy.action,
        legalBasisNote: policy.legalBasisNote,
        tenantOverrideApplied: Boolean(override),
        autoEnforced: (AUTO_ENFORCEABLE_RETENTION_CATEGORIES as readonly string[]).includes(policy.category),
      };
    });
  }

  /** Tenant self-service override — mirrors `PartitionRetentionService.upsertTenantOverride`, but UNLIKE that one this override IS operationally read by `RetentionEnforcementService` (see schema.prisma's own comment on `TenantDataRetentionOverride`). */
  upsertOverride(tx: Prisma.TransactionClient, tenantId: string, category: DataCategoryKey, retentionMonths: number): Promise<TenantDataRetentionOverride> {
    return tx.tenantDataRetentionOverride.upsert({
      where: { tenantId_category: { tenantId, category: category as never } },
      create: { tenantId, category: category as never, retentionMonths },
      update: { retentionMonths },
    });
  }

  removeOverride(tx: Prisma.TransactionClient, tenantId: string, category: DataCategoryKey): Promise<Prisma.BatchPayload> {
    return tx.tenantDataRetentionOverride.deleteMany({ where: { tenantId, category: category as never } });
  }
}
