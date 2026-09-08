import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { assertValidTimeZone, InvalidTimeZoneError } from '@hrm/shared';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * BRANCH is a plain reference table with no dedicated service in this
 * codebase (branches are created via seeding/direct Prisma today) — so,
 * unlike EMPLOYEE/LEAVE_BALANCE, this importer writes directly. Natural key:
 * `(tenantId, name)`, the SAME `@@unique` the real create-time uniqueness
 * already enforces at the DB layer — an existing branch with this name is
 * UPDATED (countryCode/timezone/parent), never duplicated.
 */
@Injectable()
export class BranchImporter implements EntityImporter {
  readonly entityType = 'BRANCH' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const name = mappedRow.name?.trim();
    const countryCode = mappedRow.countryCode?.trim().toUpperCase();
    const timezone = mappedRow.timezone?.trim();
    if (!name) throw new BadRequestException('name is required.');
    if (!countryCode || !COUNTRY_CODE_PATTERN.test(countryCode)) {
      throw new BadRequestException('countryCode must be a 2-letter country code.');
    }
    if (!timezone) throw new BadRequestException('timezone is required.');
    try {
      assertValidTimeZone(timezone);
    } catch (error) {
      if (error instanceof InvalidTimeZoneError) throw new BadRequestException(error.message);
      throw error;
    }

    let parentBranchId: string | null = null;
    const parentBranchName = mappedRow.parentBranchName?.trim();
    if (parentBranchName) {
      const parent = await tx.branch.findFirst({ where: { tenantId, name: parentBranchName }, select: { id: true } });
      if (!parent) {
        throw new BadRequestException(`parentBranchName "${parentBranchName}" was not found.`);
      }
      parentBranchId = parent.id;
    }

    const existing = await tx.branch.findFirst({ where: { tenantId, name }, select: { id: true } });
    if (existing) {
      const row = await tx.branch.update({ where: { id: existing.id }, data: { countryCode, timezone, parentBranchId } });
      return { status: 'UPDATE', entityId: row.id };
    }
    const row = await tx.branch.create({ data: { tenantId, name, countryCode, timezone, parentBranchId } });
    return { status: 'CREATE', entityId: row.id };
  }
}
