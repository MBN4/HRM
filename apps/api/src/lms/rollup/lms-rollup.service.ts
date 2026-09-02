import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma } from '@hrm/db';
import { LMS_ROLLUP_QUEUE } from '../../queue/queue.constants';
import { LMS_ROLLUP_ORCHESTRATOR_CRON, LMS_ROLLUP_ORCHESTRATOR_JOB_ID } from '../lms.constants';
import { yesterdayUtc } from './lms-rollup.util';

export interface LmsRollupJobData {
  tenantId: string;
  /** ISO-8601 date string — same convention `AnalyticsRollupJobData` already uses (Dates don't survive BullMQ's JSON serialization). */
  date: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The course-completion/training-compliance rollup job's PRODUCER side —
 * see docs/conventions/lms.md and `AnalyticsRollupService`'s doc comment
 * (1.5), the SAME scheduled-job pattern reused verbatim for LMS's own two
 * rollup tables.
 */
@Injectable()
export class LmsRollupService implements OnModuleInit {
  private readonly logger = new Logger(LmsRollupService.name);

  constructor(@InjectQueue(LMS_ROLLUP_QUEUE) private readonly queue: Queue<LmsRollupJobData | Record<string, never>>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'orchestrate',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: LMS_ROLLUP_ORCHESTRATOR_CRON }, jobId: LMS_ROLLUP_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily LMS rollup orchestrator ("${LMS_ROLLUP_ORCHESTRATOR_CRON}" UTC).`);
  }

  async enqueueTenantRollup(tenantId: string, date: Date = yesterdayUtc()): Promise<void> {
    await this.queue.add('rollup-tenant', { tenantId, date: date.toISOString() }, JOB_OPTIONS);
  }

  async enqueueForEveryLiveTenant(date: Date = yesterdayUtc()): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true } });
    await Promise.all(tenants.map((tenant) => this.enqueueTenantRollup(tenant.id, date)));
    return tenants.length;
  }
}
