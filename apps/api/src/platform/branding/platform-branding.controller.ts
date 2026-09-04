import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseInterceptors } from '@nestjs/common';
import { PLATFORM_PERMISSIONS } from '@hrm/shared';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformBrandingService } from './platform-branding.service';

/**
 * The vendor console's branding oversight surface (step 4.3) — see
 * docs/conventions/white-label.md. READ is support-safe (both platform
 * roles); every MUTATION (verify/approve/provision-tls/reset) is
 * OWNER-only, the same "READ is broad, MANAGE is narrow" split
 * `BILLING_READ`/`BILLING_MANAGE` already establish (4.2).
 */
@Controller('platform/branding')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformBrandingController {
  constructor(
    private readonly branding: PlatformBrandingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('tenants')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_READ)
  list() {
    return this.branding.listBrandings();
  }

  @Get('tenants/:tenantId/domain')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_READ)
  getDomain(@Param('tenantId') tenantId: string) {
    return this.branding.getTenantDomain(tenantId);
  }

  @Post('tenants/:tenantId/domain/:domainId/verify')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_MANAGE)
  verifyDomain(@Param('tenantId') tenantId: string, @Param('domainId') domainId: string) {
    return this.branding.verifyDomain(this.requireActorId(), tenantId, domainId);
  }

  @Post('tenants/:tenantId/domain/:domainId/approve')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_MANAGE)
  approveDomain(@Param('tenantId') tenantId: string, @Param('domainId') domainId: string) {
    return this.branding.approveDomain(this.requireActorId(), tenantId, domainId);
  }

  @Post('tenants/:tenantId/domain/:domainId/provision-tls')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_MANAGE)
  provisionTls(@Param('tenantId') tenantId: string, @Param('domainId') domainId: string) {
    return this.branding.provisionTls(this.requireActorId(), tenantId, domainId);
  }

  @Delete('tenants/:tenantId/reset')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BRANDING_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async reset(@Param('tenantId') tenantId: string) {
    await this.branding.resetBranding(this.requireActorId(), tenantId);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
