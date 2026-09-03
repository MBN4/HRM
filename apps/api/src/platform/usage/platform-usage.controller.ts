import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { PLATFORM_PERMISSIONS } from '@hrm/shared';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformUsageService } from './platform-usage.service';

@Controller('platform/usage')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
@RequirePlatformPermissions(PLATFORM_PERMISSIONS.USAGE_READ)
export class PlatformUsageController {
  constructor(private readonly usage: PlatformUsageService) {}

  @Get('overview')
  overview() {
    return this.usage.getOverview();
  }

  @Get(':tenantId')
  metrics(@Param('tenantId') tenantId: string) {
    return this.usage.getMetrics(tenantId);
  }
}
