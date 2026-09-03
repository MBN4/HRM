import { BadRequestException, Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { EMPLOYEE_STATUSES, FEATURE_FLAGS, PERMISSIONS } from '@hrm/shared';
import { PermissionSerializerInterceptor } from '../../common/permissions/permission-serializer.interceptor';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { FeatureFlagGuard } from '../../licensing/feature-flag.guard';
import { RequireFeature } from '../../licensing/require-feature.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { EmployeeService } from '../../employees/employee.service';

/**
 * A representative slice of the versioned public API (step 3.3) — see
 * docs/conventions/integrations.md for why this is a CURATED surface, not a
 * mirror of every internal route. Reuses `EmployeeService` exactly as
 * `EmployeesController` (JWT path) does; `PermissionsGuard`/
 * `PermissionSerializerInterceptor` need no changes at all to work for an
 * API-key-authenticated request — both just read
 * `TenantContextService.getPermissions()`, which `TenantScopeInterceptor`'s
 * API-key branch populates from the key's own `scopes`.
 */
@ApiTags('v1')
@ApiSecurity('ApiKeyAuth')
@Controller('v1/employees')
export class V1EmployeesController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, PermissionSerializerInterceptor)
  @RequireFeature(FEATURE_FLAGS.API_ACCESS)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({ summary: 'List employees for the authenticated tenant' })
  list(
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (status && !(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${EMPLOYEE_STATUSES.join(', ')}.`);
    }
    return this.employees.list(
      this.tenantContext.getTx(),
      { status, branchId, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined },
      this.tenantContext.getBranchIds(),
    );
  }

  @Get(':id')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, PermissionSerializerInterceptor)
  @RequireFeature(FEATURE_FLAGS.API_ACCESS)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({ summary: 'Get one employee by id' })
  findOne(@Param('id') id: string) {
    return this.employees.findById(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }
}
