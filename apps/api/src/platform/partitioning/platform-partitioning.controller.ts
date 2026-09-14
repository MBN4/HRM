import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Post, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import {
  PLATFORM_PERMISSIONS,
  partitionedTableNameParamSchema,
  updatePartitionedTableConfigRequestSchema,
  upsertTenantRetentionOverrideRequestSchema,
  type UpdatePartitionedTableConfigInput,
  type UpsertTenantRetentionOverrideInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformPartitioningService } from './platform-partitioning.service';

/**
 * The vendor console's surface over step 5.2's partitioning/archival
 * services — see docs/conventions/partitioning-archival.md. READ is
 * support-safe (both platform roles); MANAGE (config changes, manual
 * triggers, tenant retention overrides) is PLATFORM_OWNER-only, the SAME
 * "READ is broad, MANAGE is narrow" split BILLING_READ/BILLING_MANAGE and
 * BRANDING_READ/BRANDING_MANAGE already establish.
 */
@Controller('platform/partitioning')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformPartitioningController {
  constructor(
    private readonly partitioning: PlatformPartitioningService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('config')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_READ)
  listConfigs() {
    return this.partitioning.listConfigs();
  }

  @Put('config/:tableName')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_MANAGE)
  updateConfig(
    @Param('tableName', new ZodValidationPipe(partitionedTableNameParamSchema)) tableName: string,
    @Body(new ZodValidationPipe(updatePartitionedTableConfigRequestSchema)) body: UpdatePartitionedTableConfigInput,
  ) {
    return this.partitioning.updateConfig(this.requireActorId(), tableName as never, body);
  }

  @Get('status')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_READ)
  getStatus() {
    return this.partitioning.getStatus();
  }

  @Post('ensure')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_MANAGE)
  ensureNow() {
    return this.partitioning.ensurePartitionsNow(this.requireActorId());
  }

  @Post('archive')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_MANAGE)
  archiveNow() {
    return this.partitioning.runArchivalNow(this.requireActorId());
  }

  @Get('archives')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_READ)
  listArchives() {
    return this.partitioning.listArchives();
  }

  @Get('archives/:id/download')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_READ)
  async downloadArchive(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { archive, body, contentType } = await this.partitioning.getArchiveDownload(id);
    res.set({
      'Content-Type': contentType ?? 'application/gzip',
      'Content-Disposition': `attachment; filename="${archive.partitionName}.jsonl.gz"`,
    });
    return new StreamableFile(body);
  }

  @Get('tenants/:tenantId/retention-overrides')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_READ)
  listTenantOverrides(@Param('tenantId') tenantId: string) {
    return this.partitioning.listTenantOverrides(tenantId);
  }

  @Put('tenants/:tenantId/retention-overrides/:tableName')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_MANAGE)
  upsertTenantOverride(
    @Param('tenantId') tenantId: string,
    @Param('tableName', new ZodValidationPipe(partitionedTableNameParamSchema)) tableName: string,
    @Body(new ZodValidationPipe(upsertTenantRetentionOverrideRequestSchema)) body: UpsertTenantRetentionOverrideInput,
  ) {
    return this.partitioning.upsertTenantOverride(this.requireActorId(), tenantId, tableName as never, body.retentionMonths);
  }

  @Delete('tenants/:tenantId/retention-overrides/:tableName')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PARTITIONING_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTenantOverride(@Param('tenantId') tenantId: string, @Param('tableName', new ZodValidationPipe(partitionedTableNameParamSchema)) tableName: string) {
    await this.partitioning.removeTenantOverride(this.requireActorId(), tenantId, tableName as never);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
