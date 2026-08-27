import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { EMPLOYEE_DOCUMENT_TYPES, EmployeeDocumentTypeKey, PERMISSIONS } from '@hrm/shared';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { EmployeeService } from '../employee.service';
import { EmployeeDocumentsService } from './employee-documents.service';

const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;

interface EmployeeDocumentResponseDto {
  id: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Document metadata + upload/download for one employee — see
 * docs/conventions/employee.md. A separate controller (rather than folded
 * into `EmployeesController`) since these routes need `FileInterceptor`
 * (multipart) and a streamed response, a genuinely different request/
 * response shape from the rest of the module's plain-JSON routes.
 */
@Controller('employees/:employeeId/documents')
export class EmployeeDocumentsController {
  constructor(
    private readonly documents: EmployeeDocumentsService,
    private readonly employees: EmployeeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post()
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.EMPLOYEE_WRITE)
  async upload(
    @Param('employeeId') employeeId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('documentType') documentType: string,
  ): Promise<EmployeeDocumentResponseDto> {
    if (!file) {
      throw new BadRequestException('A "file" multipart field is required.');
    }
    if (!(EMPLOYEE_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      throw new BadRequestException(`documentType must be one of: ${EMPLOYEE_DOCUMENT_TYPES.join(', ')}.`);
    }
    const tenantId = this.tenantContext.getContext().tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }
    const tx = this.tenantContext.getTx();
    await this.employees.findById(tx, employeeId, this.tenantContext.getBranchIds());

    const row = await this.documents.upload(tx, {
      tenantId,
      employeeId,
      documentType: documentType as EmployeeDocumentTypeKey,
      fileName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedByUserId: this.tenantContext.userId,
    });
    return toDto(row);
  }

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async list(@Param('employeeId') employeeId: string): Promise<EmployeeDocumentResponseDto[]> {
    const tx = this.tenantContext.getTx();
    await this.employees.findById(tx, employeeId, this.tenantContext.getBranchIds());
    const rows = await this.documents.list(tx, employeeId);
    return rows.map(toDto);
  }

  @Get(':documentId')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async download(
    @Param('employeeId') employeeId: string,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const tx = this.tenantContext.getTx();
    await this.employees.findById(tx, employeeId, this.tenantContext.getBranchIds());
    const row = await this.documents.requireOne(tx, employeeId, documentId);
    const { body, contentType } = await this.documents.download(row);
    res.set({
      'Content-Type': contentType ?? row.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.fileName)}"`,
    });
    return new StreamableFile(body);
  }
}

function toDto(row: {
  id: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}): EmployeeDocumentResponseDto {
  return {
    id: row.id,
    documentType: row.documentType,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}
