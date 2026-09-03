import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { PLATFORM_PERMISSIONS, startImpersonationRequestSchema, type StartImpersonationInput } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformImpersonationService } from './platform-impersonation.service';

@Controller('platform/impersonation')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformImpersonationController {
  constructor(
    private readonly impersonation: PlatformImpersonationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('tenants/:tenantId/sessions')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.IMPERSONATION_START)
  start(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(startImpersonationRequestSchema)) body: StartImpersonationInput,
  ) {
    return this.impersonation.start(this.requireActorId(), tenantId, body);
  }

  @Get('sessions')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.AUDIT_READ)
  list(
    @Query('tenantId') tenantId?: string,
    @Query('platformAdminId') platformAdminId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.impersonation.list({ tenantId, platformAdminId, activeOnly: activeOnly === 'true' });
  }

  @Post('sessions/:sessionId/end')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.IMPERSONATION_START)
  end(@Param('sessionId') sessionId: string) {
    return this.impersonation.end(this.requireActorId(), this.requireActorRole(), sessionId, 'MANUAL');
  }

  /** Ending another admin's active session — held to a higher bar than ending your own. */
  @Post('sessions/:sessionId/revoke')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.ADMIN_MANAGE)
  revoke(@Param('sessionId') sessionId: string) {
    return this.impersonation.end(this.requireActorId(), this.requireActorRole(), sessionId, 'REVOKED');
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }

  private requireActorRole(): string {
    const role = this.tenantContext.platformRole;
    if (!role) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return role;
  }
}
