import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { EmployeeImportJob, Prisma } from '@hrm/db';
import { EMPLOYEE_IMPORT_QUEUE } from '../../queue/queue.constants';
import { parseEmployeeImportCsv } from './csv-row.util';

export interface EmployeeImportJobData {
  tenantId: string;
  importJobId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * The bulk-import PRODUCER side — mirrors 0.8's `NotificationsService`
 * shape (see docs/conventions/notifications-queues.md): create the tracking
 * row, enqueue one job, return immediately — the actual row-by-row work
 * happens in `EmployeeImportProcessor`, off the request path.
 *
 * THE SAME RACE 0.8 documents ("THE RACE") applies here too: this method
 * runs inside the request's own held-open transaction (`TenantScopeInterceptor`),
 * so `queue.add()` below can genuinely fire before that outer transaction
 * commits — a worker that immediately looked up `importJobId` could find
 * nothing yet. Rather than opening a second transaction and hand-rolling a
 * bounded retry (0.8's approach, needed there because recipient resolution
 * has to happen before any rows exist to enqueue against), this reuses the
 * SIMPLER mechanism already built into every BullMQ job in this system:
 * `EmployeeImportProcessor` just throws `NotFoundException` if the row
 * isn't there yet, and BullMQ's own `attempts`/`backoff` (the exact same
 * `JOB_OPTIONS` shape 0.8 established) retries it — by the second attempt
 * (~1s later) the outer transaction has certainly committed.
 */
@Injectable()
export class EmployeeImportService {
  constructor(@InjectQueue(EMPLOYEE_IMPORT_QUEUE) private readonly queue: Queue<EmployeeImportJobData>) {}

  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    csvContent: string,
    submittedByUserId: string | null,
  ): Promise<EmployeeImportJob> {
    const rows = parseEmployeeImportCsv(csvContent);
    const job = await tx.employeeImportJob.create({
      data: { tenantId, submittedByUserId, csvContent, status: 'PENDING', totalRows: rows.length },
    });
    await this.queue.add('process', { tenantId, importJobId: job.id }, JOB_OPTIONS);
    return job;
  }

  async findById(tx: Prisma.TransactionClient, id: string): Promise<EmployeeImportJob> {
    const row = await tx.employeeImportJob.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Import job "${id}" was not found.`);
    }
    return row;
  }
}
