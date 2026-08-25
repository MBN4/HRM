import { CountryPackConfig, LeaveDefaults, TenantCountryOverrideInput } from '@hrm/shared';

export type EffectiveCountryPackConfig = CountryPackConfig;

/**
 * A tenant override that fails the bounds check below — e.g. trying to set
 * `leaveDefaults.annualDays` under the pack's legal floor.
 */
export class InvalidCountryOverrideError extends Error {}

/**
 * Enforces "a tenant may only grant MORE than the legal floor, never
 * less" for leave entitlements — the one bound this step's brief calls out
 * by name (25 days granted vs. a 20-day legal default must be allowed; the
 * reverse must not be). Called at override write-time (see
 * `CountryPacksController.putOverride`, where a violation should be a
 * clear rejection to whoever authored the override) and defensively again
 * inside `mergeCountryPackConfig` at every resolution (in case the
 * underlying pack's floor was raised by a newer CountryPack version after
 * the override was written) — this project's stated posture is that no
 * single layer of validation is trusted alone.
 */
export function assertLeaveBoundsRespected(packDefaults: LeaveDefaults, override: Partial<LeaveDefaults>): void {
  for (const key of Object.keys(override) as Array<keyof LeaveDefaults>) {
    const overrideValue = override[key];
    const floor = packDefaults[key];
    if (overrideValue !== undefined && overrideValue < floor) {
      throw new InvalidCountryOverrideError(
        `leaveDefaults.${key} (${overrideValue}) may not be set below the country pack's legal floor (${floor}).`,
      );
    }
  }
}

function clampLeaveDefaultsToFloor(candidate: LeaveDefaults, floor: LeaveDefaults): LeaveDefaults {
  return {
    annualDays: Math.max(candidate.annualDays, floor.annualDays),
    sickDays: Math.max(candidate.sickDays, floor.sickDays),
    maternityDays: Math.max(candidate.maternityDays, floor.maternityDays),
    paternityDays: Math.max(candidate.paternityDays, floor.paternityDays),
  };
}

/**
 * Layers a tenant's override on top of a resolved CountryPack config — the
 * two-layer override model (see /CLAUDE.md § Conventions → Country packs).
 * Only the sections `tenantCountryOverrideSchema` allows (leaveDefaults,
 * workingTime, requiredEmployeeFields, payslipTemplate) are ever touched by
 * `override`; everything else — locale, tax, statutory, payrollMode,
 * hostingRegionHint — always comes straight from the pack, so a tenant can
 * never weaken a legal/compliance default no matter what `override`
 * contains (that whitelist is enforced structurally by
 * `TenantCountryOverrideInput`'s type, not re-checked here).
 */
export function mergeCountryPackConfig(
  pack: CountryPackConfig,
  override: TenantCountryOverrideInput | null,
): EffectiveCountryPackConfig {
  if (!override) {
    return pack;
  }

  const mergedLeaveDefaults = override.leaveDefaults
    ? { ...pack.leaveDefaults, ...override.leaveDefaults }
    : pack.leaveDefaults;

  return {
    ...pack,
    leaveDefaults: clampLeaveDefaultsToFloor(mergedLeaveDefaults, pack.leaveDefaults),
    workingTime: override.workingTime ? { ...pack.workingTime, ...override.workingTime } : pack.workingTime,
    requiredEmployeeFields: override.requiredEmployeeFields ?? pack.requiredEmployeeFields,
    payslipTemplate: override.payslipTemplate
      ? { ...pack.payslipTemplate, ...override.payslipTemplate }
      : pack.payslipTemplate,
  };
}
