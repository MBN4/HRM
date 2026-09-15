import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma, withTenantContext, type DataSubjectRequest } from '@hrm/db';
import type {
  CreateDataSubjectRequestInput,
  DataCategoryKey,
  PlatformPrivacyRequestQuery,
  UpdateDataRetentionPolicyInput,
  UpsertSubProcessorInput,
} from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { DataSubjectRequestService } from '../../privacy/data-subject-request.service';
import { RetentionEnforcementService } from '../../privacy/retention-enforcement.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface ResidencyOverviewRow {
  tenantId: string;
  tenantName: string;
  hostingRegion: string;
  thisDeploymentRegion: string | null;
  matchesThisDeployment: boolean | null;
}

/**
 * The vendor console's surface over the REAL step 6.1 privacy engines — see
 * docs/conventions/privacy-residency.md. This service owns no export/
 * erasure/retention logic of its own, only permission-appropriate
 * cross-tenant access plus dual audit, the SAME "platform layer wraps,
 * never reimplements, the real module" shape `PlatformPartitioningService`/
 * `PlatformMigrationService` already establish for their own domains.
 */
@Injectable()
export class PlatformPrivacyService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSubjectRequests: DataSubjectRequestService,
    private readonly retention: RetentionEnforcementService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
  ) {}

  /** Manual trigger for the scheduled sweep — the SAME "scheduled + manual, both call the identical service method" shape `POST /platform/partitioning/ensure` already establishes. */
  async runRetentionSweepNow(actorId: string): Promise<Record<string, number>> {
    const erasedByTenant = await this.retention.runSweep();
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.retention_sweep_triggered',
      entityType: 'DataSubjectRequest',
      entityId: null,
      after: { erasedByTenant },
    });
    return erasedByTenant;
  }

  // --- Processing register / retention policy / sub-processor catalog ----

  listRegister() {
    return prisma.dataProcessingRegisterEntry.findMany({ orderBy: { category: 'asc' } });
  }

  listRetentionPolicies() {
    return prisma.dataRetentionPolicy.findMany({ orderBy: { category: 'asc' } });
  }

  async updateRetentionPolicy(actorId: string, category: DataCategoryKey, input: UpdateDataRetentionPolicyInput) {
    const before = await prisma.dataRetentionPolicy.findUnique({ where: { category: category as never } });
    const after = await prisma.dataRetentionPolicy.update({ where: { category: category as never }, data: input });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.retention_policy_updated',
      entityType: 'DataRetentionPolicy',
      entityId: category,
      before,
      after,
    });
    return after;
  }

  listSubProcessors() {
    return prisma.subProcessorRecord.findMany({ orderBy: { name: 'asc' } });
  }

  async createSubProcessor(actorId: string, input: UpsertSubProcessorInput) {
    const record = await prisma.subProcessorRecord.create({ data: { ...input, dataCategories: input.dataCategories as never } });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.sub_processor_created',
      entityType: 'SubProcessorRecord',
      entityId: record.id,
      after: record,
    });
    return record;
  }

  async updateSubProcessor(actorId: string, id: string, input: UpsertSubProcessorInput) {
    const before = await prisma.subProcessorRecord.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException(`Sub-processor "${id}" was not found.`);
    }
    const after = await prisma.subProcessorRecord.update({ where: { id }, data: { ...input, dataCategories: input.dataCategories as never } });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.sub_processor_updated',
      entityType: 'SubProcessorRecord',
      entityId: id,
      before,
      after,
    });
    return after;
  }

  async deleteSubProcessor(actorId: string, id: string): Promise<void> {
    const before = await prisma.subProcessorRecord.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException(`Sub-processor "${id}" was not found.`);
    }
    await prisma.subProcessorRecord.delete({ where: { id } });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.sub_processor_deleted',
      entityType: 'SubProcessorRecord',
      entityId: id,
      before,
    });
  }

  // --- Residency oversight -------------------------------------------------

  /**
   * A cheap indexed read across every tenant's own `hostingRegion` against
   * THIS stack's own `DEPLOYMENT_REGION` — the same "cheap reads only, never
   * a live heavy scan" posture `PlatformUsageService` already establishes
   * for itself. A tenant whose region doesn't match this deployment's own
   * is exactly the misconfiguration `TenantScopeInterceptor`'s residency
   * guard (see tenant-scope.interceptor.ts) would already be REJECTING at
   * request time — this view lets a vendor operator SEE that before a
   * tenant ever hits it.
   */
  async residencyOverview(): Promise<ResidencyOverviewRow[]> {
    const thisDeploymentRegion = this.config.get<string>('DEPLOYMENT_REGION') ?? null;
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, hostingRegion: true }, orderBy: { name: 'asc' } });
    return tenants.map((tenant) => ({
      tenantId: tenant.id,
      tenantName: tenant.name,
      hostingRegion: tenant.hostingRegion,
      thisDeploymentRegion,
      matchesThisDeployment: thisDeploymentRegion ? tenant.hostingRegion === thisDeploymentRegion : null,
    }));
  }

  // --- Cross-tenant data-subject-request oversight ------------------------

  async listRequests(actorId: string, query: PlatformPrivacyRequestQuery): Promise<DataSubjectRequest[]> {
    const requests = await prisma.dataSubjectRequest.findMany({
      where: { tenantId: query.tenantId, status: query.status },
      orderBy: { createdAt: 'desc' },
      take: query.take,
    });
    // Reading the cross-tenant request trail is itself an audited action —
    // the SAME "reading the audit trail is itself audited" posture
    // PlatformAuditQueryService already establishes for cross-tenant reads.
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.requests_read',
      entityType: 'DataSubjectRequest',
      entityId: null,
      metadata: { filter: query },
    });
    return requests;
  }

  /** The platform creating a data-subject request ON A TENANT's behalf — mirrors `PlatformMigrationService`'s own reuse of `ImportBatchService` UNCHANGED, opened via `withTenantContext` so RLS still applies even though the actor is a platform admin. Dual-audited exactly like every other platform-on-a-tenant's-behalf action in this codebase. */
  async createRequestOnBehalf(actorId: string, tenantId: string, input: CreateDataSubjectRequestInput): Promise<DataSubjectRequest> {
    const request = await withTenantContext(tenantId, (tx) =>
      this.dataSubjectRequests.submit(tx, tenantId, input, { userId: null, platformAdminId: actorId }),
    );

    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action: 'privacy.request_created_by_platform',
      entityType: 'DataSubjectRequest',
      entityId: request.id,
      metadata: { platformAdminId: actorId, requestType: input.requestType, subjectType: input.subjectType },
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.privacy.request_created',
      entityType: 'DataSubjectRequest',
      entityId: request.id,
      targetTenantId: tenantId,
      after: request,
    });
    return request;
  }
}
