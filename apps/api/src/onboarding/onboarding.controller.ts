import { BadRequestException, Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  completeOnboardingSchema,
  CompleteOnboardingInput,
  createChecklistTemplateSchema,
  CreateChecklistTemplateInput,
  PERMISSIONS,
} from '@hrm/shared';
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
import { OnboardingService } from './onboarding.service';

const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The Onboarding module's HTTP surface — see
 * docs/conventions/recruitment-lifecycle.md. `POST
 * /onboarding/processes/:id/create-employee` is the one route that calls
 * the REAL, UNMODIFIED 1.1 `EmployeeService.create`. Checklist template
 * management/task completion delegate to the SHARED `ChecklistService`/
 * `ChecklistTemplateService` (also used by `OffboardingController`), with
 * `processType` fixed to `"ONBOARDING"` here.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly checklists: ChecklistService,
    private readonly checklistTemplates: ChecklistTemplateService,
    private readonly storage: StorageService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('checklist-templates')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ONBOARDING_MANAGE)
  @AuditLog('ChecklistTemplate', 'UPSERT')
  async upsertChecklistTemplate(@Body(new ZodValidationPipe(createChecklistTemplateSchema)) body: CreateChecklistTemplateInput): Promise<ChecklistTemplate> {
    if (body.processType !== 'ONBOARDING') {
      throw new BadRequestException('processType must be "ONBOARDING" on this route.');
    }
    return this.checklistTemplates.upsert(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('checklist-templates')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ONBOARDING_MANAGE)
  async listChecklistTemplates(): Promise<ChecklistTemplate[]> {
    return this.checklistTemplates.list(this.tenantContext.getTx(), 'ONBOARDING');
  }

  @Get('processes')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ONBOARDING_MANAGE)
  async listProcesses() {
    return this.onboarding.list(this.tenantContext.getTx());
  }

  @Get('processes/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ONBOARDING_MANAGE)
  async getProcess(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const process = await this.onboarding.findById(tx, id);
    const tasks = await this.onboarding.listTasks(tx, id);
    return { ...process, tasks };
  }

  @Post('processes/:id/create-employee')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ONBOARDING_MANAGE)
  @AuditLog('Employee', 'CREATE')
  async createEmployee(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(completeOnboardingSchema)) body: CompleteOnboardingInput,
    @Query('checklistTemplateName') checklistTemplateName?: string,
  ) {
    return this.onboarding.createEmployee(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.getBranchIds(),
      body,
      checklistTemplateName,
    );
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
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.ONBOARDING_MANAGE);

    let documentStorageKey: string | undefined;
    if (document) {
      documentStorageKey = `onboarding/${tenantId}/tasks/${id}-${Date.now()}-${document.originalname}`;
      await this.storage.uploadObject({ key: documentStorageKey, body: document.buffer, contentType: document.mimetype });
    }

    return this.checklists.complete(tx, id, this.tenantContext.userId!, canManage, documentStorageKey);
  }
}
