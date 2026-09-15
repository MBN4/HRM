import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma, withTenantContext } from '@hrm/db';
import { PRIVACY_QUEUE } from '../queue/queue.constants';
import { RETENTION_ENFORCEMENT_ORCHESTRATOR_CRON, RETENTION_ENFORCEMENT_ORCHESTRATOR_JOB_ID } from './privacy.constants';
import { DataSubjectRequestService } from './data-subject-request.service';
import { ProcessingRegisterService } from './processing-register.service';

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The scheduled retention-enforcement job — see
 * docs/conventions/privacy-residency.md. Builds directly on 5.2's own
 * "orchestrate -> fan out" scheduled-job shape (`AnalyticsRollupService`,
 * `PartitionMaintenanceService`) but, unlike partition archival, this sweep
 * runs entirely WITHIN each tenant's own `withTenantContext` transaction
 * (RLS-scoped, not the owner client) for the actual eligibility scan and
 * erasure write — there is no shared-partition obstacle here (see
 * `TenantDataRetentionOverride`'s own doc comment in schema.prisma), only
 * the owner client's cheap `Tenant.findMany` to discover which tenants to
 * visit at all.
 *
 * ONLY `EMPLOYEE_POST_EXIT`/`CANDIDATE_RECORDS` are auto-enforced
 * (`AUTO_ENFORCEABLE_RETENTION_CATEGORIES`) — every other category is
 * either RETAIN_LEGAL (no automatic action; see docs/conventions/
 * privacy-residency.md) or acted on only via an explicit, on-demand
 * `DataSubjectRequest`. Reuses `PrivacyErasureService` (via
 * `DataSubjectRequestService.recordSystemErasure`) — the EXACT same
 * anonymize/hard-delete engine an on-demand erasure request uses, so the
 * two paths can never diverge in what "erased" actually means for a given
 * category.
 */
@Injectable()
export class RetentionEnforcementService implements OnModuleInit {
  private readonly logger = new Logger(RetentionEnforcementService.name);

  constructor(
    @InjectQueue(PRIVACY_QUEUE) private readonly queue: Queue,
    private readonly dataSubjectRequests: DataSubjectRequestService,
    private readonly register: ProcessingRegisterService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'retention-sweep',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: RETENTION_ENFORCEMENT_ORCHESTRATOR_CRON }, jobId: RETENTION_ENFORCEMENT_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily privacy retention-enforcement sweep ("${RETENTION_ENFORCEMENT_ORCHESTRATOR_CRON}" UTC).`);
  }

  /** Called by the scheduled job AND by a manual trigger — the SAME "scheduled + manual, both call the identical service method" shape `PartitionMaintenanceService.ensureAllPartitions` already establishes. Returns how many subjects were erased, per tenant. */
  async runSweep(): Promise<Record<string, number>> {
    const tenants = await prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true } });
    const results: Record<string, number> = {};
    for (const tenant of tenants) {
      // eslint-disable-next-line no-await-in-loop -- one tenant at a time, bounded by the platform's own tenant count, not a hot path
      results[tenant.id] = await this.sweepTenant(tenant.id);
    }
    return results;
  }

  private async sweepTenant(tenantId: string): Promise<number> {
    const policies = await withTenantContext(tenantId, (tx) => this.register.effectiveRetentionPolicies(tx, tenantId));
    const byCategory = new Map(policies.map((p) => [p.category, p]));
    let erasedCount = 0;

    // AUTO_ENFORCEABLE_RETENTION_CATEGORIES names exactly these two — every
    // other category is either RETAIN_LEGAL by default or acted on only via
    // an explicit, on-demand DataSubjectRequest (see this class's own doc
    // comment).
    const employeePolicy = byCategory.get('EMPLOYEE_POST_EXIT');
    if (employeePolicy && employeePolicy.action !== 'RETAIN_LEGAL') {
      erasedCount += await this.sweepTerminatedEmployees(tenantId, employeePolicy.retentionMonths);
    }

    const candidatePolicy = byCategory.get('CANDIDATE_RECORDS');
    if (candidatePolicy && candidatePolicy.action !== 'RETAIN_LEGAL') {
      erasedCount += await this.sweepStaleCandidates(tenantId, candidatePolicy.retentionMonths);
    }

    return erasedCount;
  }

  private async sweepTerminatedEmployees(tenantId: string, retentionMonths: number): Promise<number> {
    const cutoff = monthsAgo(retentionMonths);
    const candidates = await withTenantContext(tenantId, (tx) =>
      tx.employee.findMany({
        where: { tenantId, status: 'TERMINATED', terminatedAt: { lte: cutoff }, firstName: { not: 'Erased' } },
        select: { id: true },
      }),
    );

    let erased = 0;
    for (const employee of candidates) {
      // eslint-disable-next-line no-await-in-loop -- one row at a time; retention sweeps run daily off the request path, not latency-sensitive
      const alreadyErased = await withTenantContext(tenantId, (tx) =>
        tx.dataSubjectRequest.findFirst({ where: { tenantId, subjectType: 'EMPLOYEE', subjectId: employee.id, requestType: 'ERASURE', status: 'COMPLETED' } }),
      );
      if (alreadyErased) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.dataSubjectRequests.recordSystemErasure(tenantId, 'EMPLOYEE', employee.id, `Retention window elapsed (EMPLOYEE_POST_EXIT, ${retentionMonths} months since termination).`);
      erased += 1;
    }
    return erased;
  }

  private async sweepStaleCandidates(tenantId: string, retentionMonths: number): Promise<number> {
    const cutoff = monthsAgo(retentionMonths);
    const candidates = await withTenantContext(tenantId, (tx) =>
      tx.candidate.findMany({
        where: { tenantId, updatedAt: { lte: cutoff }, onboardingProcesses: { none: { employeeId: { not: null } } } },
        select: { id: true },
      }),
    );

    let erased = 0;
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop -- one row at a time, retention-sweep pace
      await this.dataSubjectRequests.recordSystemErasure(tenantId, 'CANDIDATE', candidate.id, `Retention window elapsed (CANDIDATE_RECORDS, ${retentionMonths} months since last update).`);
      erased += 1;
    }
    return erased;
  }
}

function monthsAgo(months: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
}
