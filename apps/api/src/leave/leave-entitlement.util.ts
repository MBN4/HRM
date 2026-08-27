import { LeaveDefaults } from '@hrm/shared';
import type { LeaveType } from '@hrm/db';

/**
 * Maps a `LeaveType` to its resolved Country Pack entitlement — THE RULE
 * (see docs/conventions/country-packs.md) applied here: this is the ONLY
 * place that knows which `leaveDefaults` key corresponds to which
 * `LeaveType`; every actual DAY COUNT still comes entirely from the
 * resolved pack/override, never hardcoded. The same function resolves a US
 * branch's 10 annual days and a QA branch's 21 — see
 * docs/conventions/leave.md.
 */
export function entitlementForType(leaveDefaults: LeaveDefaults, leaveType: LeaveType): number {
  switch (leaveType) {
    case 'ANNUAL':
      return leaveDefaults.annualDays;
    case 'SICK':
      return leaveDefaults.sickDays;
    case 'MATERNITY':
      return leaveDefaults.maternityDays;
    case 'PATERNITY':
      return leaveDefaults.paternityDays;
  }
}
