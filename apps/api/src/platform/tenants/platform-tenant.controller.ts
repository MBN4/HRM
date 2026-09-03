import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseInterceptors } from '@nestjs/common';
import {
  deleteTenantRequestSchema,
  PLATFORM_PERMISSIONS,
  platformCreateTenantRequestSchema,
  platformUpdateTenantRequestSchema,
  suspendTenantRequestSchema,
  type DeleteTenantInput,
  type PlatformCreateTenantInput,
  type PlatformUpdateTenantInput,
  type SuspendTenantInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformTenantService } from './platform-tenant.service';

@Controller('platform/tenants')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformTenantController {
  constructor(
    private readonly tenants: PlatformTenantService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_READ)
  list() {
    return this.tenants.list();
  }

  @Get(':id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_READ)
  detail(@Param('id') id: string) {
    return this.tenants.detail(id);
  }

  /** The impersonation target picker — see PlatformTenantService.listUsers. */
  @Get(':id/users')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_READ)
  listUsers(@Param('id') id: string) {
    return this.tenants.listUsers(id);
  }

  @Post()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MANAGE)
  create(@Body(new ZodValidationPipe(platformCreateTenantRequestSchema)) body: PlatformCreateTenantInput) {
    return this.tenants.create(this.requireActorId(), body);
  }

  @Patch(':id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MANAGE)
  update(@Param('id') id: string, @Body(new ZodValidationPipe(platformUpdateTenantRequestSchema)) body: PlatformUpdateTenantInput) {
    return this.tenants.update(this.requireActorId(), id, body);
  }

  @Post(':id/suspend')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MANAGE)
  suspend(@Param('id') id: string, @Body(new ZodValidationPipe(suspendTenantRequestSchema)) body: SuspendTenantInput) {
    return this.tenants.suspend(this.requireActorId(), id, body);
  }

  @Post(':id/resume')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MANAGE)
  resume(@Param('id') id: string) {
    return this.tenants.resume(this.requireActorId(), id);
  }

  @Delete(':id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Body(new ZodValidationPipe(deleteTenantRequestSchema)) body: DeleteTenantInput) {
    await this.tenants.remove(this.requireActorId(), id, body);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
