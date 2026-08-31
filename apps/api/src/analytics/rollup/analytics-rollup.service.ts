import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma } from '@hrm/db';
import { ANALYTICS_ROLLUP_QUEUE } from '../../queue/queue.constants';
import { ANALYTICS_ORCHESTRATOR_CRON, ANALYTICS_ORCHESTRATOR_JOB_ID } from '../analytics.constants';
import { yesterdayUtc } from './analytics-rollup.util';

export interface AnalyticsRollupJobData {
  tenantId: string;
  /** ISO-8601 date string — Dates don't survive BullMQ's JSON serialization, same convention `AttendanceSummaryJobData` already uses. */
  date: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The rollup job's PRODUCER side, plus THE FIRST REAL SCHEDULED (cron) job
 * in this codebase — see docs/conventions/analytics-dashboard.md. Every
 * prior Phase 0/1 "periodic" job (0.7's escalation sweep, 1.2's leave
 * accrual, 1.3's attendance summary) is a documented, accepted "manual
 * trigger only, scheduling infra is out of scope" gap; this step is what
 * the task's explicit scale requirement ("compute aggregates via SCHEDULED
 * BullMQ jobs") calls for, and `bullmq@^5.28.2` (already pinned) already
 * has everything needed (`repeat`) — no new infrastructure dependency.
 * Deliberately NOT retrofitted onto 1.2/1.3's own jobs — out of this step's
 * scope, and those gaps stay separately documented where they already are.
 *
 * `onModuleInit` re-registers the SAME repeatable job (fixed `jobId`) on
 * every app boot — BullMQ's repeat scheduler is idempotent for an
 * unchanged `{ pattern, jobId }` pair, so this never creates duplicates.
 * The orchestrator job itself carries no `tenantId` — it runs OUTSIDE any
 * tenant context (see `AnalyticsRollupProcessor`'s `orchestrate` handler)
 * and fans out one `rollup-tenant` job per `ACTIVE` tenant, discovered via
 * the OWNER `prisma` client (an infrastructure listing, not a tenant
 * query — `Tenant` itself is RLS-exempt, same posture `ReadinessService`
 * already takes for its own owner-client DB check).
 */
@Injectable()
export class AnalyticsRollupService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsRollupService.name);

  constructor(@InjectQueue(ANALYTICS_ROLLUP_QUEUE) private readonly queue: Queue<AnalyticsRollupJobData | Record<string, never>>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'orchestrate',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: ANALYTICS_ORCHESTRATOR_CRON }, jobId: ANALYTICS_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily analytics rollup orchestrator ("${ANALYTICS_ORCHESTRATOR_CRON}" UTC).`);
  }

  async enqueueTenantRollup(tenantId: string, date: Date = yesterdayUtc()): Promise<void> {
    await this.queue.add('rollup-tenant', { tenantId, date: date.toISOString() }, JOB_OPTIONS);
  }

  /**
   * Called by the `orchestrate` job — see AnalyticsRollupProcessor. Kept
   * here, not on the processor, so it's reusable from a manual/test call
   * too. `TRIAL`/`ACTIVE` both still have real employees to roll up;
   * `SUSPENDED`/`CANCELLED` don't (and shouldn't keep consuming worker
   * capacity every night).
   */
  async enqueueForEveryLiveTenant(date: Date = yesterdayUtc()): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true } });
    await Promise.all(tenants.map((tenant) => this.enqueueTenantRollup(tenant.id, date)));
    return tenants.length;
  }
}
