import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { countryPackConfigSchema, OvertimeRules, PublicHolidaysCalendar, tenantCountryOverrideSchema, Weekday } from '@hrm/shared';
import { mergeCountryPackConfig } from '../country-packs/country-pack-override.util';
import { CountryPackNotFoundError } from '../country-packs/country-pack-resolution.service';

export interface EffectiveAttendancePackConfig {
  weekendDays: Weekday[];
  publicHolidays: PublicHolidaysCalendar;
  overtimeRules: OvertimeRules;
}

/**
 * Resolves the effective `workingTime.weekendDays`/`overtimeRules` +
 * `publicHolidays` for a branch — the SAME branch -> countryCode -> pack ->
 * tenant-override resolution `CountryPackResolutionService` performs,
 * DUPLICATED here with an explicit `tx`/`tenantId` signature, for the exact
 * reason `leave-country-pack.util.ts` (1.2) and
 * `employee-country-pack.util.ts` (1.1) already document for themselves:
 * `CountryPackResolutionService` reads `TenantContextService.getTx()`/
 * `.tenantId` internally, which only exist inside an HTTP request's
 * `AsyncLocalStorage` context — but this module's day-status/overtime
 * resolution must run from BOTH an HTTP request (clock-in/out) AND the
 * context-less summary-computation BullMQ worker. The actual MERGE logic
 * (`mergeCountryPackConfig`) is reused as-is, since it's a plain function
 * with no request-context dependency — the two-layer override model can
 * never drift between request-time resolution and this one. THE RULE
 * (country-packs.md) holds: nothing in this module ever branches on a
 * country code — the SAME function resolves a US Sat/Sun weekend and a QA
 * Fri/Sat one, and each pack's own `overtimeRules`.
 */
export async function resolveAttendancePackConfig(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<EffectiveAttendancePackConfig> {
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
    weekendDays: effective.workingTime.weekendDays,
    publicHolidays: effective.publicHolidays,
    overtimeRules: effective.workingTime.overtimeRules,
  };
}
