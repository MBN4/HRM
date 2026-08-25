import { Injectable, NotFoundException } from '@nestjs/common';
import { countryPackConfigSchema, tenantCountryOverrideSchema } from '@hrm/shared';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { EffectiveCountryPackConfig, mergeCountryPackConfig } from './country-pack-override.util';

export class CountryPackNotFoundError extends NotFoundException {
  constructor(countryCode: string) {
    super(`No active country pack is configured for country code "${countryCode}".`);
  }
}

/**
 * Resolves the EFFECTIVE country configuration for a branch or country
 * code — the one place any future module (leave, payroll, employee
 * fields, ...) should go for country-dependent behavior. See /CLAUDE.md §
 * Conventions → Country packs for the full write-up, and THE RULE stated
 * there: no module may ever branch on a country code itself — everything
 * must come from here.
 *
 * Always queries through the request's own RLS-scoped transaction
 * (`TenantContextService.getTx()`), same as every other tenant-aware
 * service in this codebase — `country_packs` has no RLS policy (see
 * schema.prisma) but `tenant_country_overrides` does, so both reads must
 * run inside the same transaction the tenant context was bound to.
 */
@Injectable()
export class CountryPackResolutionService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * `branch.countryCode` is the primary source; `tenant.defaultCountryCode`
   * is only a fallback for a branch that hasn't been assigned one (see
   * /CLAUDE.md § Conventions → Country resolution). `Branch.countryCode` is
   * a required column today, so this fallback is defensive/forward-looking
   * rather than commonly exercised — it still must not be deleted, per that
   * convention.
   */
  async resolveCountryCodeForBranch(branchId: string): Promise<string> {
    const tx = this.tenantContext.getTx();
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { countryCode: true, tenantId: true },
    });
    if (!branch) {
      throw new NotFoundException(`Branch "${branchId}" was not found.`);
    }
    if (branch.countryCode) {
      return branch.countryCode;
    }
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: branch.tenantId },
      select: { defaultCountryCode: true },
    });
    return tenant.defaultCountryCode;
  }

  /**
   * Resolves the active CountryPack for `countryCode` and layers the
   * current tenant's `TenantCountryOverride` on top, if one exists — the
   * two-layer model. Both the pack's `config` and the override's
   * `overrides` are re-validated against `@hrm/shared`'s schemas on this
   * read, not just when they were written — a JSON column carries no
   * schema-level guarantee of its own, consistent with this project's "no
   * single layer of validation is trusted alone" posture.
   */
  async resolveEffectiveConfig(countryCode: string): Promise<EffectiveCountryPackConfig> {
    const tx = this.tenantContext.getTx();

    const packRow = await tx.countryPack.findFirst({
      where: { countryCode, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!packRow) {
      throw new CountryPackNotFoundError(countryCode);
    }
    const pack = countryPackConfigSchema.parse(packRow.config);

    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      return pack;
    }

    const overrideRow = await tx.tenantCountryOverride.findUnique({
      where: { tenantId_countryCode: { tenantId, countryCode } },
    });
    if (!overrideRow) {
      return pack;
    }

    const override = tenantCountryOverrideSchema.parse(overrideRow.overrides);
    return mergeCountryPackConfig(pack, override);
  }

  async resolveEffectiveConfigForBranch(branchId: string): Promise<EffectiveCountryPackConfig> {
    const countryCode = await this.resolveCountryCodeForBranch(branchId);
    return this.resolveEffectiveConfig(countryCode);
  }
}
