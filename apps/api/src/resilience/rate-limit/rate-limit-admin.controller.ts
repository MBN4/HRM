import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { PLATFORM_PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePlatformPermissions } from '../../platform/decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../../platform/guards/platform-permissions.guard';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantRateLimitService } from './tenant-rate-limit.service';

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireValidTenantId(tenantId: string): string {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new BadRequestException('tenantId must be a UUID.');
  }
  return tenantId;
}

const setRateLimitOverrideSchema = z.object({
  limit: z.number().int().min(1),
  windowSeconds: z.number().int().min(1),
});
type SetRateLimitOverrideInput = z.infer<typeof setRateLimitOverrideSchema>;

/**
 * The vendor/platform lever for per-tenant rate-limit overrides — same
 * `@PlatformRoute()` seam and shape as 0.6's `LicensingAdminController`
 * (issue/revoke licenses, flag overrides). Step 4.1 added the
 * `@RequirePlatformPermissions()` gate below — before it, `@PlatformRoute()`
 * alone carried no authenticated identity at all; see
 * `LicensingAdminController`'s own updated doc comment for the full
 * writeup of what changed and why. Redis-only — no DB table, no RLS — see
 * `TenantRateLimitService` for why.
 */
@Controller('platform/rate-limits')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
@RequirePlatformPermissions(PLATFORM_PERMISSIONS.RATE_LIMIT_MANAGE)
export class RateLimitAdminController {
  constructor(private readonly tenantRateLimit: TenantRateLimitService) {}

  @Patch(':tenantId')
  async setOverride(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(setRateLimitOverrideSchema)) body: SetRateLimitOverrideInput,
  ): Promise<{ tenantId: string; override: SetRateLimitOverrideInput }> {
    const validTenantId = requireValidTenantId(tenantId);
    await this.tenantRateLimit.setOverride(validTenantId, body);
    return { tenantId: validTenantId, override: body };
  }

  @Delete(':tenantId')
  async clearOverride(@Param('tenantId') tenantId: string): Promise<{ tenantId: string; cleared: true }> {
    const validTenantId = requireValidTenantId(tenantId);
    await this.tenantRateLimit.setOverride(validTenantId, null);
    return { tenantId: validTenantId, cleared: true };
  }

  @Get(':tenantId')
  async getOverride(@Param('tenantId') tenantId: string) {
    const validTenantId = requireValidTenantId(tenantId);
    return { tenantId: validTenantId, override: await this.tenantRateLimit.getOverride(validTenantId) };
  }
}
