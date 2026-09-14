import { NotFoundException } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { EMPLOYEE_IMPORT_QUEUE } from '../../queue/queue.constants';
import { shouldAutorunWorkers } from '../../queue/queue-worker.util';
import { EmployeeService } from '../employee.service';
import { parseEmployeeImportCsv } from './csv-row.util';
import type { EmployeeImportJobData } from './employee-import.service';

interface RowError {
  row: number;
  message: string;
}

/**
 * The BullMQ worker for the `employee-import` queue — see
 * docs/conventions/employee.md and `QueueModule`'s doc comment for the
 * reusable pattern this instantiates. `csvContent` is reloaded FRESH from
 * the `EmployeeImportJob` row (never from `job.data`, which stays minimal —
 * just `{ tenantId, importJobId }`) so a retried job always sees current
 * state, the same posture 0.8's `NotificationProcessor` established.
 *
 * Runs entirely outside any HTTP request — no `TenantContextService`
 * context exists here — so every DB access opens its OWN
 * `withTenantContext` transaction. Each ROW gets its own transaction (not
 * one big transaction for the whole file): this is what gives bulk import
 * genuine ROW-LEVEL isolation — one bad row's validation failure can never
 * roll back rows that already succeeded, and a worker crash partway through
 * leaves the successfully-imported rows intact rather than losing the
 * entire batch.
 */
@Processor(EMPLOYEE_IMPORT_QUEUE, { autorun: shouldAutorunWorkers() })
export class EmployeeImportProcessor extends WorkerHost {
  constructor(private readonly employees: EmployeeService) {
    super();
  }

  async process(job: Job<EmployeeImportJobData>): Promise<void> {
    const { tenantId, importJobId } = job.data;

    const csvContent = await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const importJob = await tx.employeeImportJob.findUnique({ where: { id: importJobId } });
      if (!importJob) {
        // See EmployeeImportService's doc comment: the producer's
        // transaction may not have committed yet on an early attempt —
        // throwing lets BullMQ's own attempts/backoff retry this rather
        // than treating "not found yet" as a permanent failure.
        throw new NotFoundException(`Import job "${importJobId}" was not found.`);
      }
      if (importJob.status === 'PENDING') {
        await tx.employeeImportJob.update({ where: { id: importJobId }, data: { status: 'PROCESSING' } });
      }
      return importJob.csvContent;
    });

    const rows = parseEmployeeImportCsv(csvContent);
    const errors: RowError[] = [];
    let successCount = 0;

    for (const row of rows) {
      let rowSucceeded = false;
      if (row.error || !row.input) {
        errors.push({ row: row.rowNumber, message: row.error ?? 'Invalid row.' });
      } else {
        try {
          await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
            this.employees.create(tx, tenantId, row.input!, null),
          );
          successCount++;
          rowSucceeded = true;
        } catch (error) {
          errors.push({ row: row.rowNumber, message: error instanceof Error ? error.message : 'Unknown error.' });
        }
      }

      await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
        tx.employeeImportJob.update({
          where: { id: importJobId },
          data: { processedRows: { increment: 1 }, successCount: { increment: rowSucceeded ? 1 : 0 } },
        }),
      );
    }

    const status = errors.length === 0 ? 'COMPLETED' : successCount === 0 ? 'FAILED' : 'COMPLETED_WITH_ERRORS';
    await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
      tx.employeeImportJob.update({
        where: { id: importJobId },
        data: {
          status,
          errorCount: errors.length,
          successCount,
          errors: errors as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  }
}
