import { BadRequestException, Body, Controller, Param, Patch, Post } from '@nestjs/common';
import {
  flagOverrideRequestSchema,
  FlagOverrideInput,
  issueLicenseRequestSchema,
  IssueLicenseInput,
  revokeLicenseRequestSchema,
  RevokeLicenseInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../tenancy/platform-route.decorator';
import { LicensingAdminService } from './licensing-admin.service';

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The vendor/platform admin surface for licensing — reuses the 0.3
 * platform-context seam (`@PlatformRoute()`, off by default behind
 * `PLATFORM_MODE_ENABLED`) rather than building any part of the real
 * vendor super-admin console. Deliberately narrow: issue/revoke a license
 * file, or toggle one tenant's feature-flag override — see
 * `LicensingAdminService` for why these go through the owner/admin
 * `prisma` client instead of a tenant-scoped transaction.
 */
@Controller('platform/licensing')
export class LicensingAdminController {
  constructor(private readonly admin: LicensingAdminService) {}

  @Post('issue')
  @PlatformRoute()
  issue(@Body(new ZodValidationPipe(issueLicenseRequestSchema)) body: IssueLicenseInput) {
    return this.admin.issue(body);
  }

  @Post('revoke')
  @PlatformRoute()
  revoke(@Body(new ZodValidationPipe(revokeLicenseRequestSchema)) body: RevokeLicenseInput) {
    return this.admin.revoke(body);
  }

  @Patch('flags/:tenantId')
  @PlatformRoute()
  setFlagOverride(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(flagOverrideRequestSchema)) body: FlagOverrideInput,
  ) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new BadRequestException('tenantId must be a UUID.');
    }
    return this.admin.setFlagOverride(tenantId, body);
  }
}
