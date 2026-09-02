import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  addTicketCommentSchema,
  AddTicketCommentInput,
  assignTicketSchema,
  AssignTicketInput,
  AUDIT_ACTIONS,
  createTicketCategorySchema,
  CreateTicketCategoryInput,
  createTicketSchema,
  CreateTicketInput,
  PERMISSIONS,
  updateTicketStatusSchema,
  UpdateTicketStatusInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { StorageService } from '../storage/storage.service';
import { TicketCategoryService } from './ticket-category.service';
import { TicketService } from './ticket.service';

const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

/** HR Helpdesk / Ticketing's HTTP surface — see docs/conventions/operations-modules.md. */
@Controller('helpdesk')
export class HelpdeskController {
  constructor(
    private readonly tickets: TicketService,
    private readonly categories: TicketCategoryService,
    private readonly storage: StorageService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('categories')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.HELPDESK_MANAGE)
  @AuditLog('TicketCategory', AUDIT_ACTIONS.CREATE)
  async upsertCategory(@Body(new ZodValidationPipe(createTicketCategorySchema)) body: CreateTicketCategoryInput) {
    return this.categories.upsert(this.tenantContext.getTx(), this.tenantContext.tenantId!, body);
  }

  @Get('categories')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async listCategories() {
    return this.categories.list(this.tenantContext.getTx(), this.tenantContext.tenantId!);
  }

  @Post('tickets')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.HELPDESK_WRITE)
  @AuditLog('Ticket', AUDIT_ACTIONS.CREATE)
  async create(@Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput) {
    return this.tickets.create(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!, body);
  }

  @Get('tickets')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async list(@Query('status') status?: string, @Query('assignedToUserId') assignedToUserId?: string) {
    return this.tickets.list(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
      this.tenantContext.getBranchIds(),
      { status, assignedToUserId },
    );
  }

  @Get('tickets/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async findById(@Param('id') id: string) {
    return this.tickets.findById(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
    );
  }

  @Post('tickets/:id/comments')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.HELPDESK_WRITE)
  @AuditLog('TicketComment', AUDIT_ACTIONS.CREATE)
  async addComment(@Param('id') id: string, @Body(new ZodValidationPipe(addTicketCommentSchema)) body: AddTicketCommentInput) {
    return this.tickets.addComment(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
      body,
    );
  }

  @Get('tickets/:id/comments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async listComments(@Param('id') id: string) {
    return this.tickets.listComments(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
    );
  }

  @Post('tickets/:id/attachments')
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.HELPDESK_WRITE)
  async addAttachment(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('A "file" multipart field is required.');
    }
    const tenantId = this.tenantContext.tenantId!;
    const storageKey = `helpdesk/${tenantId}/${id}/${Date.now()}-${file.originalname}`;
    await this.storage.uploadObject({ key: storageKey, body: file.buffer, contentType: file.mimetype });
    return this.tickets.addAttachment(
      this.tenantContext.getTx(),
      tenantId,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
      storageKey,
      file.originalname,
    );
  }

  @Get('tickets/:id/attachments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async listAttachments(@Param('id') id: string) {
    return this.tickets.listAttachments(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
    );
  }

  @Get('tickets/:id/attachments/:attachmentId')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.HELPDESK_READ)
  async downloadAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const attachment = await this.tickets.requireAttachment(
      this.tenantContext.getTx(),
      this.tenantContext.tenantId!,
      id,
      attachmentId,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.HELPDESK_MANAGE),
    );
    const { body, contentType } = await this.storage.downloadObject(attachment.storageKey);
    res.set({
      'Content-Type': contentType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(attachment.fileName)}"`,
    });
    return new StreamableFile(body);
  }

  @Post('tickets/:id/assign')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.HELPDESK_MANAGE)
  @AuditLog('Ticket', AUDIT_ACTIONS.UPDATE)
  async assign(@Param('id') id: string, @Body(new ZodValidationPipe(assignTicketSchema)) body: AssignTicketInput) {
    return this.tickets.assign(this.tenantContext.getTx(), this.tenantContext.tenantId!, id, body.assignedToUserId);
  }

  @Post('tickets/:id/status')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.HELPDESK_MANAGE)
  @AuditLog('Ticket', AUDIT_ACTIONS.UPDATE)
  async updateStatus(@Param('id') id: string, @Body(new ZodValidationPipe(updateTicketStatusSchema)) body: UpdateTicketStatusInput) {
    return this.tickets.updateStatus(this.tenantContext.getTx(), this.tenantContext.tenantId!, id, body.status);
  }
}
