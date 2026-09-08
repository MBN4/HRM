import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { ColumnMappingTemplate, ImportBatch, ImportRowError } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  createImportBatchMetadataSchema,
  IMPORT_ENTITY_TYPES,
  ImportEntityTypeKey,
  PERMISSIONS,
  saveColumnMappingTemplateSchema,
  SaveColumnMappingTemplateInput,
} from '@hrm/shared';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ColumnMappingTemplateService } from './column-mapping-template.service';
import { ImportBatchService } from './import-batch.service';
import { MAX_UPLOAD_SIZE_BYTES } from './migration.constants';
import { MigrationPurgeService } from './migration-purge.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) throw new BadRequestException('No tenant context is bound to this request.');
  return tenantId;
}

function parseMetadata(rawBody: Record<string, unknown>) {
  const columnMapping = typeof rawBody.columnMapping === 'string' ? safeJsonParse(rawBody.columnMapping) : rawBody.columnMapping;
  return new ZodValidationPipe(createImportBatchMetadataSchema).transform({ ...rawBody, columnMapping });
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException('columnMapping must be a JSON object.');
  }
}

/**
 * Tenant self-serve surface for the data migration & onboarding toolkit —
 * see docs/conventions/data-migration.md. Every mutating route is
 * deny-by-default (`migration.manage`). Upload is multipart (a genuine
 * binary file, the same "doesn't fit a JSON string" posture 1.1's document
 * upload/1.3's clock-in selfie already establish) with the batch's OTHER
 * fields arriving as multipart TEXT fields (`columnMapping` JSON-encoded
 * into one of them, decoded here before schema validation) — every other
 * route in this module stays plain JSON.
 */
@Controller('migration')
export class MigrationController {
  constructor(
    private readonly batches: ImportBatchService,
    private readonly templates: ColumnMappingTemplateService,
    private readonly purge: MigrationPurgeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('batches')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  @AuditLog('ImportBatch', AUDIT_ACTIONS.CREATE)
  async createBatch(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: Record<string, unknown>,
  ): Promise<ImportBatch> {
    if (!file) throw new BadRequestException('A "file" multipart field is required.');
    const metadata = parseMetadata(rawBody);
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    return this.batches.create(
      this.tenantContext.getTx(),
      tenantId,
      { userId: this.tenantContext.userId, platformAdminId: null },
      metadata,
      { buffer: file.buffer, fileName: file.originalname },
    );
  }

  @Get('batches')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async list(@Query('entityType') entityType?: string, @Query('status') status?: string): Promise<ImportBatch[]> {
    if (entityType && !(IMPORT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new BadRequestException(`entityType must be one of: ${IMPORT_ENTITY_TYPES.join(', ')}.`);
    }
    return this.batches.list(this.tenantContext.getTx(), { entityType: entityType as ImportEntityTypeKey | undefined, status });
  }

  @Get('batches/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async getOne(@Param('id') id: string): Promise<ImportBatch> {
    return this.batches.requireBatch(this.tenantContext.getTx(), id);
  }

  @Post('batches/:id/validate')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async validate(@Param('id') id: string): Promise<ImportBatch> {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    return this.batches.submitDryRun(this.tenantContext.getTx(), tenantId, id);
  }

  @Post('batches/:id/commit')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async commit(@Param('id') id: string): Promise<ImportBatch> {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    return this.batches.submitCommit(this.tenantContext.getTx(), tenantId, id);
  }

  @Get('batches/:id/errors')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async errors(@Param('id') id: string, @Query('phase') phase?: string): Promise<ImportRowError[]> {
    return this.batches.listRowErrors(this.tenantContext.getTx(), id, phase);
  }

  @Get('batches/:id/report')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async report(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const csv = await this.batches.buildErrorReportCsv(this.tenantContext.getTx(), id);
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="import-${id}-errors.csv"` });
    return new StreamableFile(Buffer.from(csv, 'utf-8'));
  }

  @Post('mapping-templates')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  @AuditLog('ColumnMappingTemplate', AUDIT_ACTIONS.CREATE)
  async saveMappingTemplate(
    @Body(new ZodValidationPipe(saveColumnMappingTemplateSchema)) body: SaveColumnMappingTemplateInput,
  ): Promise<ColumnMappingTemplate> {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    return this.templates.create(this.tenantContext.getTx(), tenantId, this.tenantContext.userId, body);
  }

  @Get('mapping-templates')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async listMappingTemplates(@Query('entityType') entityType?: string): Promise<ColumnMappingTemplate[]> {
    if (entityType && !(IMPORT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new BadRequestException(`entityType must be one of: ${IMPORT_ENTITY_TYPES.join(', ')}.`);
    }
    return this.templates.list(this.tenantContext.getTx(), entityType as ImportEntityTypeKey | undefined);
  }

  @Delete('mapping-templates/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  @AuditLog('ColumnMappingTemplate', AUDIT_ACTIONS.DELETE)
  async removeMappingTemplate(@Param('id') id: string) {
    await this.templates.remove(this.tenantContext.getTx(), id);
    return { id };
  }

  /**
   * Manual trigger for the uploaded-file purge sweep — the SAME
   * documented, accepted "not wired to a real scheduler yet" tradeoff
   * 0.7's escalation sweep/1.2's accrual job/3.1's SLA sweep already take.
   * Cross-tenant by nature (it discovers eligible batches across every
   * tenant), so it's deliberately NOT scoped to the caller's own tenant —
   * gated on the SAME `migration.manage` permission regardless.
   */
  @Post('purge/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MIGRATION_MANAGE)
  async runPurge() {
    return this.purge.purgeExpiredFiles();
  }
}
