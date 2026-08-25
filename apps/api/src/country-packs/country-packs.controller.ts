import { BadRequestException, Body, Controller, Get, Param, Put, Query, UseInterceptors } from '@nestjs/common';
import { countryPackConfigSchema, PERMISSIONS, TenantCountryOverrideInput, tenantCountryOverrideSchema } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { assertLeaveBoundsRespected, InvalidCountryOverrideError } from './country-pack-override.util';
import { CountryPackNotFoundError, CountryPackResolutionService } from './country-pack-resolution.service';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function requireValidCountryCode(countryCode: string): string {
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) {
    throw new BadRequestException('countryCode must be an ISO 3166-1 alpha-2 code, e.g. "US" or "QA".');
  }
  return countryCode;
}

/**
 * Proves the Country Pack system end to end: `effective` is the demo
 * endpoint called for by this step's brief ("a demo endpoint returning the
 * effective config for the current branch"); `overrides/:countryCode` is
 * the write side of the two-layer override model, without which the
 * "tenant override layers over pack defaults" behavior would have no real
 * path to exercise other than writing rows directly in tests.
 */
@Controller('country-packs')
export class CountryPacksController {
  constructor(
    private readonly resolution: CountryPackResolutionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Returns the effective (pack merged with tenant override) config for a
   * branch. `branchId` defaults to the caller's own context branch (their
   * first allowed branch, if branch-scoped) when omitted.
   */
  @Get('effective')
  async effective(@Query('branchId') branchId?: string) {
    const targetBranchId = branchId ?? this.tenantContext.getContext().branchId;
    if (!targetBranchId) {
      throw new BadRequestException(
        'branchId query param is required (no default branch is set on the caller\'s context).',
      );
    }
    return this.resolution.resolveEffectiveConfigForBranch(targetBranchId);
  }

  /** Same resolution, addressed directly by country code rather than by branch — used by the rules-engine/reference tests. */
  @Get('effective/:countryCode')
  async effectiveByCountryCode(@Param('countryCode') countryCode: string) {
    return this.resolution.resolveEffectiveConfig(requireValidCountryCode(countryCode));
  }

  /**
   * Creates or replaces the calling tenant's override for one country.
   * Deny-by-default like every other mutating route in this codebase — see
   * /CLAUDE.md § Conventions → RBAC for why `PermissionsGuard` is applied
   * via `@UseInterceptors()` despite the name.
   */
  @Put('overrides/:countryCode')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.COUNTRY_PACK_OVERRIDE_MANAGE)
  async putOverride(
    @Param('countryCode') countryCode: string,
    @Body(new ZodValidationPipe(tenantCountryOverrideSchema)) body: TenantCountryOverrideInput,
  ) {
    const validCountryCode = requireValidCountryCode(countryCode);
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }

    const packRow = await tx.countryPack.findFirst({
      where: { countryCode: validCountryCode, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!packRow) {
      throw new CountryPackNotFoundError(validCountryCode);
    }
    const pack = countryPackConfigSchema.parse(packRow.config);

    if (body.leaveDefaults) {
      try {
        assertLeaveBoundsRespected(pack.leaveDefaults, body.leaveDefaults);
      } catch (error) {
        if (error instanceof InvalidCountryOverrideError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    await tx.tenantCountryOverride.upsert({
      where: { tenantId_countryCode: { tenantId, countryCode: validCountryCode } },
      update: { overrides: body },
      create: { tenantId, countryCode: validCountryCode, overrides: body },
    });

    return this.resolution.resolveEffectiveConfig(validCountryCode);
  }
}
