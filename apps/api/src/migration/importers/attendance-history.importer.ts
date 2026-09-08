import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { emptyToUndefined } from '../file-parsing/parse-import-file';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

const ATTENDANCE_STATUS_PATTERN = /^[A-Z_]{1,16}$/;

/**
 * Historical attendance data, kept scoped and READ-ONLY per the brief —
 * see docs/conventions/data-migration.md. Deliberately writes into its OWN
 * `MigratedAttendanceSummary` table, NOT the real 1.3
 * `AttendanceDailySummary` rollup: that table is freely RECOMPUTED by
 * `AttendanceSummaryProcessor` from real clock records, so a migrated row
 * living there would silently vanish the first time that job runs for the
 * same employee/day. This module never recomputes attendance — the
 * client's own historical figures are carried forward as-is.
 *
 * `status` is accepted as a free-form short code (not validated against
 * `AttendanceDayStatus`) — a client's prior system may use its own
 * vocabulary (`P`/`A`/`Present`/...), and this is display-only historical
 * data, never fed back into any real attendance computation.
 */
@Injectable()
export class AttendanceHistoryImporter implements EntityImporter {
  readonly entityType = 'ATTENDANCE_HISTORY' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const employeeCode = mappedRow.employeeCode?.trim();
    if (!employeeCode) throw new BadRequestException('employeeCode is required.');
    const workDateRaw = mappedRow.workDate?.trim();
    const workDate = workDateRaw ? new Date(workDateRaw) : null;
    if (!workDate || Number.isNaN(workDate.getTime())) throw new BadRequestException('workDate must be a valid date.');
    const status = mappedRow.status?.trim().toUpperCase();
    if (!status || !ATTENDANCE_STATUS_PATTERN.test(status)) {
      throw new BadRequestException('status must be 1-16 uppercase letters/underscores.');
    }
    const workedMinutes = parseOptionalInt(mappedRow.workedMinutes, 'workedMinutes');
    const overtimeMinutes = parseOptionalInt(mappedRow.overtimeMinutes, 'overtimeMinutes');

    const employee = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode } } });
    if (!employee) throw new BadRequestException(`employeeCode "${employeeCode}" was not found — import employees first.`);

    const row = await tx.migratedAttendanceSummary.create({
      data: {
        tenantId,
        importBatchId,
        employeeId: employee.id,
        workDate,
        status,
        workedMinutes,
        overtimeMinutes,
        note: emptyToUndefined(mappedRow.note) ?? null,
      },
    });
    return { status: 'CREATE', entityId: row.id };
  }
}

function parseOptionalInt(value: string | undefined, field: string): number | undefined {
  const raw = emptyToUndefined(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`${field} must be a non-negative whole number.`);
  }
  return parsed;
}
