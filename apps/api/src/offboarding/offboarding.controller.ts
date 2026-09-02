import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createChecklistTemplateSchema, CreateChecklistTemplateInput, initiateOffboardingSchema, InitiateOffboardingInput, PERMISSIONS } from '@hrm/shared';
import type { ChecklistTemplate } from '@hrm/db';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { StorageService } from '../storage/storage.service';
import { ChecklistService } from '../checklists/checklist.service';
import { ChecklistTemplateService } from '../checklists/checklist-template.service';
import { OffboardingService } from './offboarding.service';

const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The Offboarding module's HTTP surface — see
 * docs/conventions/recruitment-lifecycle.md. Deliberately no
 * approve/reject route — THE RULE: act via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`, keyed off the
 * `workflowInstanceId` returned on `GET /offboarding/processes/:id`.
 */
@Controller('offboarding')
export class OffboardingController {
  constructor(
    private readonly offboarding: OffboardingService,
    private readonly checklists: ChecklistService,
    private readonly checklistTemplates: ChecklistTemplateService,
    private readonly storage: StorageService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('processes')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  @AuditLog('OffboardingProcess', 'CREATE')
  async initiate(@Body(new ZodValidationPipe(initiateOffboardingSchema)) body: InitiateOffboardingInput) {
    return this.offboarding.initiate(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.getBranchIds(),
      body,
    );
  }

  @Get('processes')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  async list() {
    return this.offboarding.list(this.tenantContext.getTx(), this.tenantContext.getBranchIds());
  }

  @Get('processes/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  async getProcess(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const process = await this.offboarding.findById(tx, id, this.tenantContext.getBranchIds());
    const tasks = await this.offboarding.listTasks(tx, id);
    return { ...process, tasks };
  }

  @Post('processes/:id/complete')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  @AuditLog('OffboardingProcess', 'COMPLETE')
  async complete(@Param('id') id: string) {
    return this.offboarding.complete(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.getBranchIds(),
      id,
    );
  }

  @Post('checklist-templates')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  @AuditLog('ChecklistTemplate', 'UPSERT')
  async upsertChecklistTemplate(@Body(new ZodValidationPipe(createChecklistTemplateSchema)) body: CreateChecklistTemplateInput): Promise<ChecklistTemplate> {
    if (body.processType !== 'OFFBOARDING') {
      throw new BadRequestException('processType must be "OFFBOARDING" on this route.');
    }
    return this.checklistTemplates.upsert(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('checklist-templates')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.OFFBOARDING_MANAGE)
  async listChecklistTemplates(): Promise<ChecklistTemplate[]> {
    return this.checklistTemplates.list(this.tenantContext.getTx(), 'OFFBOARDING');
  }

  @Get('my-tasks')
  async myTasks() {
    return this.checklists.myTasks(this.tenantContext.getTx(), this.tenantContext.userId!);
  }

  @Post('tasks/:id/complete')
  @UseInterceptors(FileInterceptor('document', { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } }))
  async completeTask(@Param('id') id: string, @UploadedFile() document: Express.Multer.File | undefined) {
    const tx = this.tenantContext.getTx();
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.OFFBOARDING_MANAGE);

    let documentStorageKey: string | undefined;
    if (document) {
      documentStorageKey = `offboarding/${tenantId}/tasks/${id}-${Date.now()}-${document.originalname}`;
      await this.storage.uploadObject({ key: documentStorageKey, body: document.buffer, contentType: document.mimetype });
    }

    return this.offboarding.completeTask(tx, tenantId, id, this.tenantContext.userId!, canManage, documentStorageKey);
  }
}
