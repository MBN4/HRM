import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import type { EmployeeImportJob } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  createEmployeeSchema,
  CreateEmployeeInput,
  EMPLOYEE_STATUSES,
  employeeImportRequestSchema,
  EmployeeImportRequestInput,
  PERMISSIONS,
  updateEmployeeSchema,
  UpdateEmployeeInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditCaptureService } from '../audit/audit-capture.service';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { EmployeeImportService } from './import/employee-import.service';
import { EmployeeListResult, EmployeeService } from './employee.service';
import { EmployeeResponseDto } from './employee-response.dto';
import { OrgChartNode, OrgChartService } from './org-chart.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The Employee module's core surface — see docs/conventions/employee.md.
 * Every mutating route is deny-by-default (`employee.write`) and
 * `@AuditLog`'d; every response goes through `PermissionSerializerInterceptor`
 * so `EmployeeResponseDto.compensation` is omitted for callers without
 * `salary.view` (see employee-response.dto.ts). Branch scoping is enforced
 * by `EmployeeService`/`OrgChartService` themselves, reading
 * `tenantContext.getBranchIds()` — the same two-layer shape (RBAC gates the
 * feature, the service layer gates the row) established in 0.4.
 */
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly orgChart: OrgChartService,
    private readonly imports: EmployeeImportService,
    private readonly tenantContext: TenantContextService,
    private readonly auditCapture: AuditCaptureService,
  ) {}

  @Post()
  @UseInterceptors(PermissionsGuard, AuditInterceptor, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_WRITE)
  @AuditLog('Employee', AUDIT_ACTIONS.CREATE)
  async create(@Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeInput): Promise<EmployeeResponseDto> {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    return this.employees.create(this.tenantContext.getTx(), tenantId, body, this.tenantContext.getBranchIds());
  }

  @Get()
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async list(
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<EmployeeListResult> {
    if (status && !(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${EMPLOYEE_STATUSES.join(', ')}.`);
    }
    return this.employees.list(
      this.tenantContext.getTx(),
      {
        status,
        branchId,
        departmentId,
        search,
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
      this.tenantContext.getBranchIds(),
    );
  }

  /** Registered before `GET /employees/:id` — a literal path segment always wins over `:id` in Nest's routing only if declared first. */
  @Get('org-chart')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async getOrgChart(@Query('branchId') branchId?: string): Promise<OrgChartNode[]> {
    return this.orgChart.build(this.tenantContext.getTx(), branchId, this.tenantContext.getBranchIds());
  }

  /**
   * Also registered before `GET /employees/:id` for the same routing
   * reason. The one genuinely missing read this step's ESS profile screen
   * needs — see `EmployeeService.findOwn`'s doc comment — added here
   * rather than reusing any existing route, since none can resolve
   * "which Employee is the caller" on their own.
   */
  @Get('me')
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async findOwn(): Promise<EmployeeResponseDto> {
    return this.employees.findOwn(this.tenantContext.getTx(), this.tenantContext.userId!);
  }

  @Post('import')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_WRITE)
  @AuditLog('EmployeeImportJob', AUDIT_ACTIONS.CREATE)
  async submitImport(@Body(new ZodValidationPipe(employeeImportRequestSchema)) body: EmployeeImportRequestInput) {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    const job = await this.imports.submit(this.tenantContext.getTx(), tenantId, body.csvContent, this.tenantContext.userId);
    return { id: job.id, status: job.status, totalRows: job.totalRows };
  }

  @Get('import-jobs/:jobId')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async getImportJob(@Param('jobId') jobId: string): Promise<EmployeeImportJob> {
    return this.imports.findById(this.tenantContext.getTx(), jobId);
  }

  @Get(':id')
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async findOne(@Param('id') id: string): Promise<EmployeeResponseDto> {
    return this.employees.findById(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }

  /**
   * Captures the pre-update employee (already decrypted/shaped like the
   * eventual response, so `before`/`after` in the audit trail are directly
   * comparable) via `AuditCaptureService` — same reference usage
   * `country-packs.controller.ts`'s `putOverride` established in 0.9.
   * `AuditRecordService`'s redaction pass (see
   * docs/conventions/audit-custom-fields.md) strips `bankDetails`/
   * `compensation` from BOTH `before` and `after` before either ever
   * reaches `audit_log` — this is what makes a salary CHANGE auditable
   * ("a salary field was touched, by whom, when") without ever writing the
   * actual salary value to the audit trail.
   */
  @Patch(':id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_WRITE)
  @AuditLog('Employee', AUDIT_ACTIONS.UPDATE)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeInput,
  ): Promise<EmployeeResponseDto> {
    const tenantId = requireTenantId(this.tenantContext.getContext().tenantId);
    const tx = this.tenantContext.getTx();
    const branchIds = this.tenantContext.getBranchIds();
    const before = await this.employees.findById(tx, id, branchIds);
    this.auditCapture.setBefore(before);
    return this.employees.update(tx, tenantId, id, body, branchIds);
  }
}
