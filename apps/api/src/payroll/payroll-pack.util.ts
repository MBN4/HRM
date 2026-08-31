import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { countryPackConfigSchema, tenantCountryOverrideSchema } from '@hrm/shared';
import { mergeCountryPackConfig, EffectiveCountryPackConfig } from '../country-packs/country-pack-override.util';
import { CountryPackNotFoundError } from '../country-packs/country-pack-resolution.service';

export interface ResolvedPayrollPack {
  countryCode: string;
  config: EffectiveCountryPackConfig;
}

/**
 * Resolves the FULL effective CountryPack config for a branch — every
 * field, not a narrowed subset — because payroll genuinely needs all of
 * it: `tax`/`statutory`/`payrollMode` (never tenant-overridable) AND
 * `workingTime`/`payslipTemplate` (tenant-overridable, so overtime pricing
 * and payslip rendering must go through the SAME merged config leave/
 * attendance already do, not the raw pack).
 *
 * DUPLICATED here with an explicit `tx`/`tenantId` signature rather than
 * calling `CountryPackResolutionService` directly — the SAME reason
 * `resolveLeavePackConfig`/`resolveAttendancePackConfig` already document
 * for themselves: this must run from BOTH an HTTP request AND the
 * context-less `PayrollRunProcessor` worker, and `CountryPackResolutionService`
 * reads `TenantContextService.getTx()` internally, which only exists
 * inside a request. The actual merge logic (`mergeCountryPackConfig`) is
 * reused as-is — the two-layer override model can never drift between
 * request-time resolution and this one.
 */
export async function resolvePayrollPackConfig(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<ResolvedPayrollPack> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { countryCode: true, tenantId: true },
  });
  if (!branch) {
    throw new NotFoundException(`Branch "${branchId}" was not found.`);
  }

  let countryCode = branch.countryCode;
  if (!countryCode) {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: branch.tenantId }, select: { defaultCountryCode: true } });
    countryCode = tenant.defaultCountryCode;
  }

  const packRow = await tx.countryPack.findFirst({ where: { countryCode, isActive: true }, orderBy: { version: 'desc' } });
  if (!packRow) {
    throw new CountryPackNotFoundError(countryCode);
  }
  const pack = countryPackConfigSchema.parse(packRow.config);

  const overrideRow = await tx.tenantCountryOverride.findUnique({ where: { tenantId_countryCode: { tenantId, countryCode } } });
  const config = overrideRow ? mergeCountryPackConfig(pack, tenantCountryOverrideSchema.parse(overrideRow.overrides)) : pack;

  return { countryCode, config };
}
