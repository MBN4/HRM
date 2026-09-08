import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { LEAVE_TYPES } from '@hrm/shared';
import { LeaveBalanceService } from '../../leave/leave-balance.service';
import { emptyToUndefined } from '../file-parsing/parse-import-file';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

/**
 * Opening leave balances — a client migrating mid-year has accrued
 * balances that must carry over (see docs/conventions/leave.md,
 * docs/conventions/data-migration.md). Routes through the REAL
 * `LeaveBalanceService`: `getOrCreateBalance` resolves the correct
 * `entitledDays` SNAPSHOT from the employee's branch's effective Country
 * Pack (never invented here), then `setOpeningBalance` (additive, step
 * 3.5.1) SETS `accruedDays`/`carriedOverDays` to exactly what the client's
 * file says — a genuine "opening balance," not a delta on top of whatever
 * this freshly created row already holds (unlike the existing HR
 * `adjust()` action, which IS a delta).
 *
 * Natural key: `(tenantId, employeeId, leaveType, periodYear)` — the SAME
 * `@@unique` `LeaveBalance` already enforces via `getOrCreateBalance`
 * itself, so this is inherently UPDATE-or-CREATE, never a duplicate.
 */
@Injectable()
export class LeaveBalanceImporter implements EntityImporter {
  readonly entityType = 'LEAVE_BALANCE' as const;

  constructor(private readonly leaveBalances: LeaveBalanceService) {}

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const employeeCode = mappedRow.employeeCode?.trim();
    if (!employeeCode) throw new BadRequestException('employeeCode is required.');
    const leaveType = mappedRow.leaveType?.trim().toUpperCase();
    if (!leaveType || !(LEAVE_TYPES as readonly string[]).includes(leaveType)) {
      throw new BadRequestException(`leaveType must be one of: ${LEAVE_TYPES.join(', ')}.`);
    }
    const periodYear = Number(mappedRow.periodYear);
    if (!Number.isInteger(periodYear)) throw new BadRequestException('periodYear must be a whole number.');
    const accruedDays = Number(mappedRow.accruedDays);
    if (!Number.isFinite(accruedDays) || accruedDays < 0) {
      throw new BadRequestException('accruedDays must be a non-negative number.');
    }
    const carriedOverRaw = emptyToUndefined(mappedRow.carriedOverDays);
    const carriedOverDays = carriedOverRaw !== undefined ? Number(carriedOverRaw) : undefined;
    if (carriedOverDays !== undefined && (!Number.isFinite(carriedOverDays) || carriedOverDays < 0)) {
      throw new BadRequestException('carriedOverDays must be a non-negative number.');
    }

    const employee = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode } } });
    if (!employee) throw new BadRequestException(`employeeCode "${employeeCode}" was not found — import employees first.`);

    const alreadyExists = await tx.leaveBalance.findUnique({
      where: { tenantId_employeeId_leaveType_periodYear: { tenantId, employeeId: employee.id, leaveType: leaveType as never, periodYear } },
    });

    const row = await this.leaveBalances.setOpeningBalance(
      tx,
      tenantId,
      employee.id,
      employee.branchId,
      leaveType as never,
      periodYear,
      { accruedDays, carriedOverDays },
    );
    return { status: alreadyExists ? 'UPDATE' : 'CREATE', entityId: row.id };
  }
}
