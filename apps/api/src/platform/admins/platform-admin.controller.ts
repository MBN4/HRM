import { Body, Controller, Get, Param, Patch, Post, UseInterceptors } from '@nestjs/common';
import {
  createPlatformAdminRequestSchema,
  PLATFORM_PERMISSIONS,
  updatePlatformAdminRequestSchema,
  type CreatePlatformAdminInput,
  type UpdatePlatformAdminInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformAdminService } from './platform-admin.service';

/** Managing OTHER platform admin accounts — PLATFORM_OWNER only (see PlatformAdminService's own doc comment). */
@Controller('platform/admins')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformAdminController {
  constructor(
    private readonly admins: PlatformAdminService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.ADMIN_MANAGE)
  list() {
    return this.admins.list();
  }

  @Post()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.ADMIN_MANAGE)
  create(@Body(new ZodValidationPipe(createPlatformAdminRequestSchema)) body: CreatePlatformAdminInput) {
    return this.admins.create(this.requireActorId(), body);
  }

  @Patch(':id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.ADMIN_MANAGE)
  update(@Param('id') id: string, @Body(new ZodValidationPipe(updatePlatformAdminRequestSchema)) body: UpdatePlatformAdminInput) {
    return this.admins.update(this.requireActorId(), id, body);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
