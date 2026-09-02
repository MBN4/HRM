import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma } from '@hrm/db';
import { LMS_CERTIFICATION_EXPIRY_QUEUE } from '../queue/queue.constants';
import { LMS_EXPIRY_ORCHESTRATOR_CRON, LMS_EXPIRY_ORCHESTRATOR_JOB_ID } from './lms.constants';

export interface LmsExpiryJobData {
  tenantId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The certification expiry-reminder job's PRODUCER side — the SAME
 * "register one repeatable job idempotently on every boot, fan out one
 * per-tenant job from an owner-client tenant listing" shape
 * `AnalyticsRollupService` established in 1.5 (see
 * docs/conventions/analytics-dashboard.md and
 * docs/conventions/lms.md) — reused here verbatim for a second,
 * independent schedule. Compliance-relevant: some trainings are legally
 * required and must be renewed, so this reminder is a real control, not a
 * cosmetic nudge.
 */
@Injectable()
export class CertificationExpiryService implements OnModuleInit {
  private readonly logger = new Logger(CertificationExpiryService.name);

  constructor(@InjectQueue(LMS_CERTIFICATION_EXPIRY_QUEUE) private readonly queue: Queue<LmsExpiryJobData | Record<string, never>>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'orchestrate',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: LMS_EXPIRY_ORCHESTRATOR_CRON }, jobId: LMS_EXPIRY_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily LMS certification-expiry orchestrator ("${LMS_EXPIRY_ORCHESTRATOR_CRON}" UTC).`);
  }

  async enqueueTenantSweep(tenantId: string): Promise<void> {
    await this.queue.add('sweep-tenant', { tenantId }, JOB_OPTIONS);
  }

  async enqueueForEveryLiveTenant(): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true } });
    await Promise.all(tenants.map((tenant) => this.enqueueTenantSweep(tenant.id)));
    return tenants.length;
  }
}
