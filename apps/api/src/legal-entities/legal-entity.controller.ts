import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  assignEntityBranchesSchema,
  createLegalEntitySchema,
  PERMISSIONS,
  updateLegalEntitySchema,
  type AssignEntityBranchesInput,
  type CreateLegalEntityInput,
  type UpdateLegalEntityInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { LegalEntityService } from './legal-entity.service';

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Legal-entity administration (`entity.manage`) — see docs/conventions/legal-entities.md. Every route is
 * tenant-scoped through the request transaction (RLS), so one tenant can never see/edit another's
 * entities. Mutations are audited (the audit sink redacts `bankDetails`/`taxId` values).
 */
@Controller('legal-entities')
@UseInterceptors(PermissionsGuard)
@RequirePermissions(PERMISSIONS.ENTITY_MANAGE)
export class LegalEntityController {
  constructor(
    private readonly entities: LegalEntityService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @UseInterceptors(PermissionSerializerInterceptor)
  list() {
    return this.entities.list(this.tenantContext.getTx());
  }

  @Post()
  @UseInterceptors(PermissionSerializerInterceptor, AuditInterceptor)
  @AuditLog('LegalEntity', 'CREATE')
  create(@Body(new ZodValidationPipe(createLegalEntitySchema)) body: CreateLegalEntityInput) {
    return this.entities.create(this.tenantContext.getTx(), this.requireTenantId(), body);
  }

  @Get(':id')
  @UseInterceptors(PermissionSerializerInterceptor)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.entities.get(this.tenantContext.getTx(), id);
  }

  @Patch(':id')
  @UseInterceptors(PermissionSerializerInterceptor, AuditInterceptor)
  @AuditLog('LegalEntity', 'UPDATE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateLegalEntitySchema)) body: UpdateLegalEntityInput,
  ) {
    return this.entities.update(this.tenantContext.getTx(), id, body);
  }

  @Delete(':id')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('LegalEntity', 'DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.entities.remove(this.tenantContext.getTx(), id);
  }

  @Post(':id/default')
  @UseInterceptors(PermissionSerializerInterceptor, AuditInterceptor)
  @AuditLog('LegalEntity', 'SET_DEFAULT')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.entities.setDefault(this.tenantContext.getTx(), id);
  }

  @Put(':id/branches')
  @UseInterceptors(PermissionSerializerInterceptor, AuditInterceptor)
  @AuditLog('LegalEntity', 'ASSIGN_BRANCHES')
  assignBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignEntityBranchesSchema)) body: AssignEntityBranchesInput,
  ) {
    return this.entities.assignBranches(this.tenantContext.getTx(), id, body);
  }

  @Get(':id/employees')
  listEmployees(@Param('id', ParseUUIDPipe) id: string) {
    return this.entities.listEmployees(
      this.tenantContext.getTx(),
      id,
      this.tenantContext.getBranchIds(),
    );
  }

  @Post(':id/logo')
  @UseInterceptors(
    PermissionSerializerInterceptor,
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }),
    AuditInterceptor,
  )
  @AuditLog('LegalEntity', 'UPLOAD_LOGO')
  uploadLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('A "file" upload is required.');
    }
    return this.entities.uploadLogo(this.tenantContext.getTx(), this.requireTenantId(), id, file);
  }

  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { body, contentType } = await this.entities.downloadLogo(this.tenantContext.getTx(), id);
    res.set({ 'Content-Type': contentType ?? 'application/octet-stream' });
    return new StreamableFile(body);
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }
}
