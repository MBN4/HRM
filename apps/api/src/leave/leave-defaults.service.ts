import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import {
  countryPackConfigSchema,
  LeaveDefaults,
  LEAVE_TYPES,
  tenantCountryOverrideSchema,
  TenantCountryOverrideInput,
  UpdateLeaveDefaultsInput,
} from '@hrm/shared';
import { mergeCountryPackConfig, assertLeaveBoundsRespected, InvalidCountryOverrideError } from '../country-packs/country-pack-override.util';
import { CountryPackNotFoundError } from '../country-packs/country-pack-resolution.service';
import { ACCRUED_LEAVE_TYPES } from './leave.constants';
import { entitlementForType } from './leave-entitlement.util';

const KEY_LABEL: Record<keyof LeaveDefaults, string> = {
  annualDays: 'Annual leave',
  sickDays: 'Sick leave',
  maternityDays: 'Maternity leave',
  paternityDays: 'Paternity leave',
};

export interface LeaveDefaultsCountryDto {
  countryCode: string;
  /** The Country Pack's own days — the legal floor a tenant may never go below. */
  legalFloor: LeaveDefaults;
  /** What this tenant has explicitly set (null/absent key = inherits the pack). */
  override: Partial<LeaveDefaults> | null;
  /** What members actually get (override clamped up to the floor). */
  effective: LeaveDefaults;
  memberCount: number;
}

export interface LeaveDefaultsApplyResult {
  year: number;
  /** ACTIVE employees in branches of this country. */
  members: number;
  /** Balance rows created for members that had none yet (new entitlements allocated). */
  balancesCreated: number;
  /** Existing current-year rows whose entitlement was RAISED (earned/used/carry-over untouched). */
  balancesRaised: number;
}

/**
 * Step 8.1 Part 4 — default leave allocation. A thin admin layer over the EXISTING 0.5 two-layer override
 * (`TenantCountryOverride.overrides.leaveDefaults`) and the EXISTING 1.2 balance model; it invents no
 * parallel store. See docs/conventions/leave.md § Default leave allocation.
 */
@Injectable()
export class LeaveDefaultsService {
  private async loadPack(tx: Prisma.TransactionClient, countryCode: string) {
    const row = await tx.countryPack.findFirst({ where: { countryCode, isActive: true }, orderBy: { version: 'desc' } });
    if (!row) throw new CountryPackNotFoundError(countryCode);
    return countryPackConfigSchema.parse(row.config);
  }

  private async loadOverride(tx: Prisma.TransactionClient, tenantId: string, countryCode: string) {
    const row = await tx.tenantCountryOverride.findUnique({ where: { tenantId_countryCode: { tenantId, countryCode } } });
    return row ? tenantCountryOverrideSchema.parse(row.overrides) : null;
  }

  private async describe(tx: Prisma.TransactionClient, tenantId: string, countryCode: string, memberCount: number): Promise<LeaveDefaultsCountryDto> {
    const pack = await this.loadPack(tx, countryCode);
    const override = await this.loadOverride(tx, tenantId, countryCode);
    return {
      countryCode,
      legalFloor: pack.leaveDefaults,
      override: override?.leaveDefaults ?? null,
      effective: mergeCountryPackConfig(pack, override).leaveDefaults,
      memberCount,
    };
  }

  /** One entry per country the tenant has branches in (a tenant's branches may span packs, each with its own floor). */
  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<{ year: number; countries: LeaveDefaultsCountryDto[] }> {
    const branches = await tx.branch.findMany({ select: { id: true, countryCode: true } });
    const codes = [...new Set(branches.map((b) => b.countryCode))].sort();
    const countries: LeaveDefaultsCountryDto[] = [];
    for (const code of codes) {
      const memberCount = await tx.employee.count({ where: { status: 'ACTIVE', branch: { countryCode: code } } });
      try {
        countries.push(await this.describe(tx, tenantId, code, memberCount));
      } catch (e) {
        if (!(e instanceof CountryPackNotFoundError)) throw e; // a branch in a country with no active pack is simply not configurable here
      }
    }
    return { year: new Date().getUTCFullYear(), countries };
  }

  /**
   * Saves the tenant's defaults for one country, then allocates them. REJECTS (400, with the legal minimum
   * spelled out) any value below the pack's floor — the SAME bound `assertLeaveBoundsRespected` enforces for
   * the raw 0.5 override route, so the two surfaces can never disagree.
   */
  async update(
    tx: Prisma.TransactionClient,
    tenantId: string,
    countryCode: string,
    input: UpdateLeaveDefaultsInput,
    setBefore: (before: unknown) => void,
  ): Promise<{ country: LeaveDefaultsCountryDto; applied: LeaveDefaultsApplyResult }> {
    const pack = await this.loadPack(tx, countryCode);

    const violations = (Object.keys(input) as Array<keyof LeaveDefaults>)
      .filter((k) => input[k] !== undefined && (input[k] as number) < pack.leaveDefaults[k])
      .map((k) => `${KEY_LABEL[k]} cannot be set to ${input[k]} day(s): the legal minimum for ${countryCode} is ${pack.leaveDefaults[k]} day(s). Enter ${pack.leaveDefaults[k]} or more.`);
    if (violations.length > 0) {
      throw new BadRequestException({ message: violations.join(' '), violations, legalFloor: pack.leaveDefaults });
    }
    try {
      assertLeaveBoundsRespected(pack.leaveDefaults, input); // defence in depth — same function as the 0.5 route
    } catch (e) {
      if (e instanceof InvalidCountryOverrideError) throw new BadRequestException(e.message);
      throw e;
    }

    const existing = await tx.tenantCountryOverride.findUnique({ where: { tenantId_countryCode: { tenantId, countryCode } } });
    setBefore(existing?.overrides ?? null);
    const current: TenantCountryOverrideInput = existing ? tenantCountryOverrideSchema.parse(existing.overrides) : {};
    // Only the leaveDefaults section changes; every other override section (working time, required fields, payslip) is preserved.
    const next: TenantCountryOverrideInput = { ...current, leaveDefaults: { ...(current.leaveDefaults ?? {}), ...input } };
    await tx.tenantCountryOverride.upsert({
      where: { tenantId_countryCode: { tenantId, countryCode } },
      update: { overrides: next },
      create: { tenantId, countryCode, overrides: next },
    });

    const effective = mergeCountryPackConfig(pack, next).leaveDefaults;
    const applied = await this.allocate(tx, tenantId, countryCode, effective);
    const memberCount = applied.members;
    return { country: await this.describe(tx, tenantId, countryCode, memberCount), applied };
  }

  /**
   * Allocates the effective defaults to every ACTIVE member of this country's branches, through the 1.2 balance
   * model (same row shape `LeaveBalanceService.getOrCreateBalance` creates):
   *  - members with NO current-year balance get one at the new default (ANNUAL/SICK start at 0 accrued and
   *    accrue monthly; MATERNITY/PATERNITY are available in full) — new members do this lazily at first touch;
   *  - existing current-year rows are only ever RAISED: `entitledDays` (the accrual cap) goes up to the new
   *    default, and for the non-accrued types the increase is granted too. `accruedDays` already earned,
   *    `usedDays` and `carriedOverDays` are never rewritten, and a LOWERED default never takes anything away —
   *    it applies to new allocations / next period only.
   */
  private async allocate(tx: Prisma.TransactionClient, tenantId: string, countryCode: string, effective: LeaveDefaults): Promise<LeaveDefaultsApplyResult> {
    const year = new Date().getUTCFullYear();
    const employees = await tx.employee.findMany({ where: { status: 'ACTIVE', branch: { countryCode } }, select: { id: true } });
    const ids = employees.map((e) => e.id);
    let balancesCreated = 0;
    let balancesRaised = 0;
    if (ids.length === 0) return { year, members: 0, balancesCreated, balancesRaised };

    for (const leaveType of LEAVE_TYPES) {
      const entitled = entitlementForType(effective, leaveType);
      const accrued = (ACCRUED_LEAVE_TYPES as readonly string[]).includes(leaveType);
      const created = await tx.leaveBalance.createMany({
        data: ids.map((employeeId) => ({ tenantId, employeeId, leaveType, periodYear: year, entitledDays: entitled, accruedDays: accrued ? 0 : entitled })),
        skipDuplicates: true,
      });
      balancesCreated += created.count;
      // Raise-only, in one statement; the non-accrued types also receive the increase as available days.
      const raised = accrued
        ? await tx.$executeRaw`UPDATE "leave_balances" SET "entitled_days" = ${entitled}, "updated_at" = now()
            WHERE "tenant_id" = ${tenantId}::uuid AND "leave_type" = ${leaveType}::"LeaveType" AND "period_year" = ${year}
              AND "employee_id" = ANY(${ids}::uuid[]) AND "entitled_days" < ${entitled}`
        : await tx.$executeRaw`UPDATE "leave_balances" SET "accrued_days" = "accrued_days" + (${entitled} - "entitled_days"), "entitled_days" = ${entitled}, "updated_at" = now()
            WHERE "tenant_id" = ${tenantId}::uuid AND "leave_type" = ${leaveType}::"LeaveType" AND "period_year" = ${year}
              AND "employee_id" = ANY(${ids}::uuid[]) AND "entitled_days" < ${entitled}`;
      balancesRaised += Number(raised);
    }
    return { year, members: ids.length, balancesCreated, balancesRaised };
  }

  requireCountry(code: string): string {
    if (!/^[A-Za-z]{2}$/.test(code)) throw new NotFoundException('Unknown country code.');
    return code.toUpperCase();
  }
}
