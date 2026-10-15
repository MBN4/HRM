import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma, withTenantContext } from '@hrm/db';
import type { Prisma } from '@hrm/db';
import { ENGAGEMENT_CELEBRATIONS_QUEUE } from '../queue/queue.constants';
import { CELEBRATIONS_ORCHESTRATOR_CRON, CELEBRATIONS_ORCHESTRATOR_JOB_ID, NEW_JOINER_WINDOW_DAYS } from './engagement.constants';
import { utcDate } from './engagement-people.util';

export interface CelebrationsJobData {
  tenantId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

interface Row {
  id: string;
  join_date: Date;
}

/**
 * Derives CELEBRATION feed posts from existing employee data — birthdays (`dateOfBirth`, month/day
 * only: the year/age is never stored or shown), work anniversaries (`joinDate`, >= 1 full year) and
 * new joiners (joined within the last `NEW_JOINER_WINDOW_DAYS`). Only ACTIVE employees.
 *
 * IDEMPOTENT by construction: every post carries a `celebrationKey` (`BIRTHDAY:<emp>:<year>`,
 * `WORK_ANNIVERSARY:<emp>:<year>`, `NEW_JOINER:<emp>`) under a `(tenantId, celebrationKey)` unique
 * constraint and is written with `createMany({ skipDuplicates })`, so re-running a day (retry, the
 * manual endpoint, overlapping runs) never duplicates a post. The producer side mirrors the SAME
 * "one repeatable job registered idempotently on boot, fanned out per tenant from an owner-client
 * tenant listing" shape as 1.5's analytics rollup and 3.2's certification-expiry job. Dates are
 * evaluated in UTC (documented; a per-branch-timezone "today" is a fast-follow).
 *
 * The posts hold NO prose — `celebrationKind`, the subject employee and `meta` (`{ years }`) —
 * so the UI renders them in the viewer's own language.
 */
@Injectable()
export class CelebrationsService implements OnModuleInit {
  private readonly logger = new Logger(CelebrationsService.name);

  constructor(@InjectQueue(ENGAGEMENT_CELEBRATIONS_QUEUE) private readonly queue: Queue<CelebrationsJobData | Record<string, never>>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add('orchestrate', {}, { ...JOB_OPTIONS, repeat: { pattern: CELEBRATIONS_ORCHESTRATOR_CRON }, jobId: CELEBRATIONS_ORCHESTRATOR_JOB_ID });
    this.logger.log(`Registered the daily engagement-celebrations orchestrator ("${CELEBRATIONS_ORCHESTRATOR_CRON}" UTC).`);
  }

  async enqueueForEveryLiveTenant(): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true } });
    await Promise.all(tenants.map((t) => this.queue.add('generate-tenant', { tenantId: t.id }, JOB_OPTIONS)));
    return tenants.length;
  }

  /** Worker entry: one tenant, in its own tenant-scoped transaction. */
  async generateForTenant(tenantId: string, date: Date = utcDate()): Promise<number> {
    return withTenantContext(tenantId, (tx) => this.generate(tx, tenantId, date));
  }

  /** Generates the posts for `date` inside the caller's transaction; returns how many were NEW. */
  async generate(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<number> {
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const year = date.getUTCFullYear();
    const windowStart = new Date(date.getTime() - NEW_JOINER_WINDOW_DAYS * 86_400_000);

    const birthdays = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM employees
      WHERE tenant_id = ${tenantId}::uuid AND status = 'ACTIVE' AND date_of_birth IS NOT NULL
        AND EXTRACT(MONTH FROM date_of_birth) = ${month} AND EXTRACT(DAY FROM date_of_birth) = ${day}`;
    const anniversaries = await tx.$queryRaw<Row[]>`
      SELECT id, join_date FROM employees
      WHERE tenant_id = ${tenantId}::uuid AND status = 'ACTIVE'
        AND EXTRACT(MONTH FROM join_date) = ${month} AND EXTRACT(DAY FROM join_date) = ${day}
        AND EXTRACT(YEAR FROM join_date) < ${year}`;
    const joiners = await tx.employee.findMany({
      where: { tenantId, status: 'ACTIVE', joinDate: { gt: windowStart, lte: date } },
      select: { id: true },
    });

    const data: Prisma.FeedPostCreateManyInput[] = [
      ...birthdays.map((e) => ({ tenantId, type: 'CELEBRATION' as const, body: '', celebrationKind: 'BIRTHDAY' as const, subjectEmployeeId: e.id, celebrationKey: `BIRTHDAY:${e.id}:${year}` })),
      ...anniversaries.map((e) => ({
        tenantId, type: 'CELEBRATION' as const, body: '', celebrationKind: 'WORK_ANNIVERSARY' as const, subjectEmployeeId: e.id,
        celebrationKey: `WORK_ANNIVERSARY:${e.id}:${year}`, meta: { years: year - e.join_date.getUTCFullYear() },
      })),
      ...joiners.map((e) => ({ tenantId, type: 'CELEBRATION' as const, body: '', celebrationKind: 'NEW_JOINER' as const, subjectEmployeeId: e.id, celebrationKey: `NEW_JOINER:${e.id}` })),
    ];
    if (data.length === 0) return 0;
    const result = await tx.feedPost.createMany({ data, skipDuplicates: true });
    return result.count;
  }
}
