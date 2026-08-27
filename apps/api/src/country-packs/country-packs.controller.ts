import { BadRequestException, Body, Controller, Get, Param, Put, Query, UseInterceptors } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  countryPackConfigSchema,
  PERMISSIONS,
  TenantCountryOverrideInput,
  tenantCountryOverrideSchema,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditCaptureService } from '../audit/audit-capture.service';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
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
    private readonly auditCapture: AuditCaptureService,
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
   * via `@UseInterceptors()` despite the name. Also `@AuditLog`'d — a
   * tenant weakening/strengthening a legal-floor-adjacent config like
   * leave defaults is exactly the kind of sensitive mutation 0.9's audit
   * log exists to capture automatically; the pre-upsert row (if any) is
   * captured explicitly via `AuditCaptureService` since a generic
   * interceptor has no way to know what "before" means for this route.
   */
  @Put('overrides/:countryCode')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.COUNTRY_PACK_OVERRIDE_MANAGE)
  @AuditLog('TenantCountryOverride', AUDIT_ACTIONS.UPDATE)
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

    const existing = await tx.tenantCountryOverride.findUnique({
      where: { tenantId_countryCode: { tenantId, countryCode: validCountryCode } },
    });
    this.auditCapture.setBefore(existing?.overrides ?? null);

    await tx.tenantCountryOverride.upsert({
      where: { tenantId_countryCode: { tenantId, countryCode: validCountryCode } },
      update: { overrides: body },
      create: { tenantId, countryCode: validCountryCode, overrides: body },
    });

    return this.resolution.resolveEffectiveConfig(validCountryCode);
  }
}
