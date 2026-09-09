import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { SignatureEvent } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  createGeneratedSignatureRequestSchema,
  createUploadedSignatureRequestFieldsSchema,
  CreateGeneratedSignatureRequestInput,
  declineSignatureSchema,
  DeclineSignatureInput,
  PERMISSIONS,
  signDocumentSchema,
  SignDocumentInput,
  signersArraySchema,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SignatureRequestService } from './signature-request.service';
import { SigningService } from './signing.service';

const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Admin/HR + internal-signer (ESS) HTTP surface — see
 * docs/conventions/e-signatures.md. External (unauthenticated, token-based)
 * signing has its own controller — see `external-signing.controller.ts` —
 * since it needs neither a JWT nor an RBAC permission.
 *
 * A `StreamableFile`-returning route never carries `AuditInterceptor` —
 * the same lesson payroll.md documents for its own bank-export/payslip
 * downloads (redacting a live stream overflows the call stack).
 */
@Controller('e-signatures')
export class SignatureRequestController {
  constructor(
    private readonly requests: SignatureRequestService,
    private readonly signing: SigningService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('requests')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('SignatureRequest', AUDIT_ACTIONS.CREATE)
  async create(@Body(new ZodValidationPipe(createGeneratedSignatureRequestSchema)) body: CreateGeneratedSignatureRequestInput) {
    return this.requests.createGenerated(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      this.tenantContext.userId!,
      this.tenantContext.getPermissions(),
      body,
    );
  }

  @Post('requests/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }), AuditInterceptor)
  @AuditLog('SignatureRequest', AUDIT_ACTIONS.CREATE)
  async createFromUpload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(createUploadedSignatureRequestFieldsSchema)) fields: ReturnType<typeof createUploadedSignatureRequestFieldsSchema.parse>,
  ) {
    if (!file) {
      throw new BadRequestException('A "file" upload is required.');
    }
    const signers = signersArraySchema.parse(JSON.parse(fields.signersJson));
    return this.requests.createFromUpload(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      this.tenantContext.userId!,
      this.tenantContext.getPermissions(),
      fields,
      signers,
      { buffer: file.buffer, mimetype: file.mimetype },
    );
  }

  @Get('requests')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async list(@Query('status') status?: string, @Query('entityType') entityType?: string) {
    return this.requests.list(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.getBranchIds(), {
      status,
      entityType,
    });
  }

  @Get('requests/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async getById(@Param('id') id: string) {
    return this.requests.findWithSigners(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Post('requests/:id/send')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_REQUEST)
  @AuditLog('SignatureRequest', AUDIT_ACTIONS.UPDATE)
  async send(@Param('id') id: string) {
    return this.requests.send(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Post('requests/:id/cancel')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  @AuditLog('SignatureRequest', AUDIT_ACTIONS.UPDATE)
  async cancel(@Param('id') id: string) {
    return this.requests.cancel(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Get('requests/:id/document')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async downloadDocument(@Param('id') id: string): Promise<StreamableFile> {
    const { object, mimeType } = await this.requests.getDocument(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
    return new StreamableFile(object.body, { type: mimeType ?? object.contentType });
  }

  @Get('requests/:id/certificate')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async downloadCertificate(@Param('id') id: string): Promise<StreamableFile> {
    const object = await this.requests.getCertificate(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
    return new StreamableFile(object.body, { type: 'application/pdf' });
  }

  @Get('requests/:id/events')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async events(@Param('id') id: string): Promise<SignatureEvent[]> {
    const tx = this.tenantContext.getTx();
    await this.requests.requireById(tx, this.tenantContext.tenantId!, id);
    return tx.signatureEvent.findMany({ where: { tenantId: this.tenantContext.tenantId!, signatureRequestId: id }, orderBy: { occurredAt: 'asc' } });
  }

  @Get('requests/:id/verify')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_MANAGE)
  async verify(@Param('id') id: string) {
    return this.requests.verifyIntegrity(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  // --- Internal (ESS) self-service signing --------------------------------

  @Get('my-pending')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_SIGN)
  async myPending() {
    const tx = this.tenantContext.getTx();
    return tx.signatureSigner.findMany({
      where: {
        tenantId: this.tenantContext.tenantId!,
        userId: this.tenantContext.userId!,
        status: { in: ['SENT', 'VIEWED'] },
      },
      orderBy: { sentAt: 'desc' },
    });
  }

  @Get('my-signatures/:signerId/document')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_SIGN)
  async viewMine(@Param('signerId') signerId: string): Promise<StreamableFile> {
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveInternal(tx, this.tenantContext.tenantId!, signerId, this.tenantContext.userId!);
    const { object, mimeType } = await this.signing.view(tx, this.tenantContext.tenantId!, signer);
    return new StreamableFile(object.body, { type: mimeType ?? object.contentType });
  }

  @Post('my-signatures/:signerId/sign')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_SIGN)
  @AuditLog('SignatureSigner', AUDIT_ACTIONS.UPDATE)
  async signMine(
    @Param('signerId') signerId: string,
    @Body(new ZodValidationPipe(signDocumentSchema)) body: SignDocumentInput,
    @Req() req: Request,
  ) {
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveInternal(tx, this.tenantContext.tenantId!, signerId, this.tenantContext.userId!);
    return this.signing.sign(tx, this.tenantContext.tenantId!, signer, body, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('my-signatures/:signerId/decline')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ESIGNATURE_SIGN)
  @AuditLog('SignatureSigner', AUDIT_ACTIONS.UPDATE)
  async declineMine(
    @Param('signerId') signerId: string,
    @Body(new ZodValidationPipe(declineSignatureSchema)) body: DeclineSignatureInput,
    @Req() req: Request,
  ) {
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveInternal(tx, this.tenantContext.tenantId!, signerId, this.tenantContext.userId!);
    return this.signing.decline(tx, this.tenantContext.tenantId!, signer, body.reason, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
