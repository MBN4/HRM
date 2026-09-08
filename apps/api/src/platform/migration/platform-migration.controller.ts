import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { ImportBatch, ImportRowError } from '@hrm/db';
import { createImportBatchMetadataSchema, IMPORT_ENTITY_TYPES, ImportEntityTypeKey, PLATFORM_PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MAX_UPLOAD_SIZE_BYTES } from '../../migration/migration.constants';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformMigrationService } from './platform-migration.service';

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException('columnMapping must be a JSON object.');
  }
}

/**
 * Vendor/platform admin onboarding-import surface — see
 * docs/conventions/vendor-console.md's onboarding-tool note and
 * docs/conventions/data-migration.md. Same shape as every other
 * `@PlatformRoute()` controller: `PlatformPermissionsGuard` at the class
 * level, `@RequirePlatformPermissions(TENANT_MIGRATION_MANAGE)` per route
 * (held by BOTH platform roles — see platform-permissions.ts, the same
 * onboarding-support risk tier `IMPERSONATION_START` already documents for
 * itself).
 */
@Controller('platform/tenants/:tenantId/migration')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformMigrationController {
  constructor(
    private readonly service: PlatformMigrationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('batches')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }))
  async createBatch(
    @Param('tenantId') tenantId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: Record<string, unknown>,
  ): Promise<ImportBatch> {
    if (!file) throw new BadRequestException('A "file" multipart field is required.');
    const columnMapping = typeof rawBody.columnMapping === 'string' ? safeJsonParse(rawBody.columnMapping) : rawBody.columnMapping;
    const metadata = new ZodValidationPipe(createImportBatchMetadataSchema).transform({ ...rawBody, columnMapping });
    return this.service.createBatch(this.requireActorId(), tenantId, metadata, { buffer: file.buffer, fileName: file.originalname });
  }

  @Get('batches')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  list(
    @Param('tenantId') tenantId: string,
    @Query('entityType') entityType?: string,
    @Query('status') status?: string,
  ): Promise<ImportBatch[]> {
    if (entityType && !(IMPORT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new BadRequestException(`entityType must be one of: ${IMPORT_ENTITY_TYPES.join(', ')}.`);
    }
    return this.service.list(tenantId, { entityType: entityType as ImportEntityTypeKey | undefined, status });
  }

  @Get('batches/:id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  getOne(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<ImportBatch> {
    return this.service.getOne(tenantId, id);
  }

  @Post('batches/:id/validate')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  validate(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<ImportBatch> {
    return this.service.validate(this.requireActorId(), tenantId, id);
  }

  @Post('batches/:id/commit')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  commit(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<ImportBatch> {
    return this.service.commit(this.requireActorId(), tenantId, id);
  }

  @Get('batches/:id/errors')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  errors(@Param('tenantId') tenantId: string, @Param('id') id: string, @Query('phase') phase?: string): Promise<ImportRowError[]> {
    return this.service.errors(tenantId, id, phase);
  }

  @Get('batches/:id/report')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.TENANT_MIGRATION_MANAGE)
  async report(@Param('tenantId') tenantId: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const csv = await this.service.report(this.requireActorId(), tenantId, id);
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="import-${id}-errors.csv"` });
    return new StreamableFile(Buffer.from(csv, 'utf-8'));
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) throw new BadRequestException('No platform admin is bound to this request.');
    return id;
  }
}
