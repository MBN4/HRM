import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import type { Asset, AssetMaintenanceRecord } from '@hrm/db';
import {
  assignAssetSchema,
  AssignAssetInput,
  AUDIT_ACTIONS,
  completeMaintenanceRecordSchema,
  CompleteMaintenanceRecordInput,
  createAssetCategorySchema,
  CreateAssetCategoryInput,
  createAssetSchema,
  CreateAssetInput,
  createMaintenanceRecordSchema,
  CreateMaintenanceRecordInput,
  PERMISSIONS,
  returnAssetSchema,
  ReturnAssetInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AssetCategoryService } from './asset-category.service';
import { AssetService } from './asset.service';

/** Asset Management's HTTP surface — see docs/conventions/operations-modules.md. */
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetService,
    private readonly categories: AssetCategoryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('categories')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('AssetCategory', AUDIT_ACTIONS.CREATE)
  async upsertCategory(@Body(new ZodValidationPipe(createAssetCategorySchema)) body: CreateAssetCategoryInput) {
    return this.categories.upsert(this.tenantContext.getTx(), this.tenantContext.tenantId!, body);
  }

  @Get('categories')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async listCategories() {
    return this.categories.list(this.tenantContext.getTx(), this.tenantContext.tenantId!);
  }

  @Post()
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('Asset', AUDIT_ACTIONS.CREATE)
  async register(@Body(new ZodValidationPipe(createAssetSchema)) body: CreateAssetInput): Promise<Asset> {
    return this.assets.register(this.tenantContext.getTx(), this.tenantContext.tenantId!, body);
  }

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async list(@Query('status') status?: string, @Query('categoryId') categoryId?: string, @Query('branchId') branchId?: string): Promise<Asset[]> {
    return this.assets.list(this.tenantContext.getTx(), this.tenantContext.tenantId!, { status, categoryId, branchId }, this.tenantContext.getBranchIds());
  }

  @Get('my')
  async myAssignments() {
    return this.assets.listMyAssignments(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!);
  }

  @Get('employees/:employeeId/assignments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async assignmentsForEmployee(@Param('employeeId') employeeId: string) {
    return this.assets.listAssignmentsForEmployee(this.tenantContext.getTx(), this.tenantContext.tenantId!, employeeId);
  }

  @Get(':id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async findById(@Param('id') id: string): Promise<Asset> {
    return this.assets.findById(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Get(':id/assignments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async assignmentsForAsset(@Param('id') id: string) {
    return this.assets.listAssignmentsForAsset(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Post('assign')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('AssetAssignment', AUDIT_ACTIONS.CREATE)
  async assign(@Body(new ZodValidationPipe(assignAssetSchema)) body: AssignAssetInput) {
    return this.assets.assign(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!, body);
  }

  @Post('assignments/:id/return')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('AssetAssignment', AUDIT_ACTIONS.UPDATE)
  async returnAsset(@Param('id') id: string, @Body(new ZodValidationPipe(returnAssetSchema)) body: ReturnAssetInput) {
    return this.assets.returnAsset(this.tenantContext.getTx(), this.tenantContext.tenantId!, id, this.tenantContext.userId!, body);
  }

  @Post('maintenance')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('AssetMaintenanceRecord', AUDIT_ACTIONS.CREATE)
  async createMaintenance(@Body(new ZodValidationPipe(createMaintenanceRecordSchema)) body: CreateMaintenanceRecordInput): Promise<AssetMaintenanceRecord> {
    return this.assets.createMaintenanceRecord(this.tenantContext.getTx(), this.tenantContext.tenantId!, body);
  }

  @Post('maintenance/:id/complete')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @AuditLog('AssetMaintenanceRecord', AUDIT_ACTIONS.UPDATE)
  async completeMaintenance(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(completeMaintenanceRecordSchema)) body: CompleteMaintenanceRecordInput,
  ): Promise<AssetMaintenanceRecord> {
    return this.assets.completeMaintenanceRecord(this.tenantContext.getTx(), this.tenantContext.tenantId!, id, body.cost);
  }

  @Get(':id/maintenance')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async listMaintenance(@Param('id') id: string): Promise<AssetMaintenanceRecord[]> {
    return this.assets.listMaintenanceForAsset(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }
}
