import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { countryPackConfigSchema, LeaveDefaults, PublicHolidaysCalendar, tenantCountryOverrideSchema, Weekday } from '@hrm/shared';
import { mergeCountryPackConfig } from '../country-packs/country-pack-override.util';
import { CountryPackNotFoundError } from '../country-packs/country-pack-resolution.service';

export interface EffectiveLeavePackConfig {
  leaveDefaults: LeaveDefaults;
  weekendDays: Weekday[];
  publicHolidays: PublicHolidaysCalendar;
}

/**
 * Resolves the effective `leaveDefaults`/`workingTime.weekendDays`/
 * `publicHolidays` for a branch — the SAME branch -> countryCode -> pack ->
 * tenant-override resolution `CountryPackResolutionService` performs,
 * DUPLICATED here with an explicit `tx`/`tenantId` signature, for the exact
 * reason `apps/api/src/employees/employee-country-pack.util.ts` (1.1)
 * already documents for itself: `CountryPackResolutionService` reads
 * `TenantContextService.getTx()`/`.tenantId` internally, which only exist
 * inside an HTTP request's `AsyncLocalStorage` context — but this module's
 * entitlement/day-count resolution must run from BOTH an HTTP request
 * (`LeaveService`) AND the scheduled-accrual BullMQ worker (no request
 * context at all). The actual MERGE logic (`mergeCountryPackConfig`) is
 * reused as-is, since it's a plain function with no request-context
 * dependency — the two-layer override model can never drift between
 * request-time resolution and this one.
 */
export async function resolveLeavePackConfig(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<EffectiveLeavePackConfig> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { countryCode: true, tenantId: true },
  });
  if (!branch) {
    throw new NotFoundException(`Branch "${branchId}" was not found.`);
  }

  let countryCode = branch.countryCode;
  if (!countryCode) {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: branch.tenantId },
      select: { defaultCountryCode: true },
    });
    countryCode = tenant.defaultCountryCode;
  }

  const packRow = await tx.countryPack.findFirst({
    where: { countryCode, isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!packRow) {
    throw new CountryPackNotFoundError(countryCode);
  }
  const pack = countryPackConfigSchema.parse(packRow.config);

  const overrideRow = await tx.tenantCountryOverride.findUnique({
    where: { tenantId_countryCode: { tenantId, countryCode } },
  });
  const effective = overrideRow
    ? mergeCountryPackConfig(pack, tenantCountryOverrideSchema.parse(overrideRow.overrides))
    : pack;

  return {
    leaveDefaults: effective.leaveDefaults,
    weekendDays: effective.workingTime.weekendDays,
    publicHolidays: effective.publicHolidays,
  };
}
