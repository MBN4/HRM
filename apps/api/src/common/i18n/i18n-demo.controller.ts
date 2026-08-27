import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { directionFor } from '@hrm/shared';
import { CountryPackResolutionService } from '../../country-packs/country-pack-resolution.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { TimezoneService } from './timezone.service';

/**
 * Proves the i18n/timezone/RTL conventions end to end — see /CLAUDE.md §
 * Conventions → i18n / timezone / RTL. Same "demo endpoint proving a
 * cross-cutting mechanism with no dedicated entity to hang it off of" role
 * as `GET /auth/rbac-demo` (0.4) / `GET /tenancy/permission-field-demo`
 * (0.4) / `GET /licensing/demo/advanced-reporting` (0.6). Reuses
 * `CountryPackResolutionService` (0.5) for locale/RTL rather than
 * re-deriving it — the same reuse
 * `NotificationLocaleResolverService` (0.8) already established for the
 * notification hub.
 */
@Controller('i18n')
export class I18nDemoController {
  constructor(
    private readonly resolution: CountryPackResolutionService,
    private readonly tenantContext: TenantContextService,
    private readonly timezone: TimezoneService,
  ) {}

  /** `branchId` defaults to the caller's own context branch, same convention as `GET /country-packs/effective`. */
  @Get('demo')
  async demo(@Query('branchId') branchId?: string) {
    const targetBranchId = branchId ?? this.tenantContext.getContext().branchId;
    if (!targetBranchId) {
      throw new BadRequestException(
        'branchId query param is required (no default branch is set on the caller\'s context).',
      );
    }

    const tx = this.tenantContext.getTx();
    const branch = await tx.branch.findUnique({
      where: { id: targetBranchId },
      select: { timezone: true, countryCode: true },
    });
    if (!branch) {
      throw new BadRequestException(`Branch "${targetBranchId}" was not found.`);
    }

    const effective = await this.resolution.resolveEffectiveConfig(branch.countryCode);
    const nowUtc = new Date().toISOString();

    return {
      nowUtc,
      timezone: branch.timezone,
      formatted: this.timezone.format(nowUtc, branch.timezone, effective.locale.defaultLanguage),
      locale: effective.locale.defaultLanguage,
      rtl: effective.locale.rtl,
      direction: directionFor(effective.locale.rtl),
    };
  }
}
