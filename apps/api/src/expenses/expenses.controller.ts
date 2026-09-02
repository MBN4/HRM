import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { ExpenseCategory, ExpenseClaim, ExpenseLine } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  createExpenseCategorySchema,
  CreateExpenseCategoryInput,
  expenseLineInputSchema,
  ExpenseLineInput,
  PERMISSIONS,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { StorageService } from '../storage/storage.service';
import { ExpenseCategoryService } from './expense-category.service';
import { ExpenseClaimService } from './expense-claim.service';

const MAX_RECEIPT_SIZE_BYTES = 20 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * Expenses & Reimbursements' HTTP surface — see
 * docs/conventions/operations-modules.md. Deliberately no approve/reject
 * route — THE RULE: act via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`, keyed off the
 * `workflowInstanceId` returned on `GET /expenses/claims/:id`.
 */
@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly claims: ExpenseClaimService,
    private readonly categories: ExpenseCategoryService,
    private readonly storage: StorageService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('categories')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EXPENSE_MANAGE)
  @AuditLog('ExpenseCategory', AUDIT_ACTIONS.CREATE)
  async upsertCategory(@Body(new ZodValidationPipe(createExpenseCategorySchema)) body: CreateExpenseCategoryInput): Promise<ExpenseCategory> {
    return this.categories.upsert(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('categories')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  async listCategories(): Promise<ExpenseCategory[]> {
    return this.categories.list(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId));
  }

  @Post('claims')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EXPENSE_WRITE)
  @AuditLog('ExpenseClaim', AUDIT_ACTIONS.CREATE)
  async createDraft(@Body('employeeId') employeeId: string | undefined): Promise<ExpenseClaim> {
    return this.claims.createDraft(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
      this.tenantContext.getBranchIds(),
      employeeId,
    );
  }

  @Post('claims/:id/lines')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EXPENSE_WRITE)
  @AuditLog('ExpenseLine', AUDIT_ACTIONS.CREATE)
  async addLine(@Param('id') id: string, @Body(new ZodValidationPipe(expenseLineInputSchema)) body: ExpenseLineInput): Promise<ExpenseLine> {
    return this.claims.addLine(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
      body,
    );
  }

  @Post('claims/:id/lines/:lineId/receipt')
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.EXPENSE_WRITE)
  async attachReceipt(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ExpenseLine> {
    if (!file) {
      throw new BadRequestException('A "file" multipart field is required.');
    }
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManageOthers = this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE);
    const tx = this.tenantContext.getTx();
    const receiptStorageKey = `expenses/${tenantId}/${id}/${lineId}-${Date.now()}-${file.originalname}`;
    await this.storage.uploadObject({ key: receiptStorageKey, body: file.buffer, contentType: file.mimetype });
    return this.claims.attachReceipt(tx, tenantId, id, lineId, this.tenantContext.userId!, canManageOthers, receiptStorageKey);
  }

  @Get('claims/:id/lines/:lineId/receipt')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  async downloadReceipt(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.claims.findById(
      this.tenantContext.getTx(),
      tenantId,
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
      this.tenantContext.getBranchIds(),
    );
    const line = await this.claims.requireLine(this.tenantContext.getTx(), tenantId, id, lineId);
    if (!line.receiptStorageKey) {
      throw new BadRequestException('This expense line has no receipt attached.');
    }
    const { body, contentType } = await this.storage.downloadObject(line.receiptStorageKey);
    res.set({ 'Content-Type': contentType ?? 'application/octet-stream' });
    return new StreamableFile(body);
  }

  @Delete('claims/:id/lines/:lineId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EXPENSE_WRITE)
  @AuditLog('ExpenseLine', AUDIT_ACTIONS.DELETE)
  async removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    await this.claims.removeLine(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      lineId,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
    );
    return { removed: true };
  }

  @Post('claims/:id/submit')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EXPENSE_WRITE)
  @AuditLog('ExpenseClaim', AUDIT_ACTIONS.UPDATE)
  async submit(@Param('id') id: string): Promise<ExpenseClaim> {
    return this.claims.submit(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
    );
  }

  @Get('claims')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  async list(@Query('employeeId') employeeId?: string, @Query('status') status?: string): Promise<(ExpenseClaim & { lines: ExpenseLine[] })[]> {
    return this.claims.list(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
      this.tenantContext.getBranchIds(),
      { employeeId, status },
    );
  }

  @Get('claims/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  async findById(@Param('id') id: string): Promise<ExpenseClaim & { lines: ExpenseLine[] }> {
    return this.claims.findById(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.EXPENSE_MANAGE),
      this.tenantContext.getBranchIds(),
    );
  }
}
