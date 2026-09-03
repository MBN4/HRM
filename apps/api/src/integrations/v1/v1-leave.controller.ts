import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { FEATURE_FLAGS, PERMISSIONS } from '@hrm/shared';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { FeatureFlagGuard } from '../../licensing/feature-flag.guard';
import { RequireFeature } from '../../licensing/require-feature.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { LeaveService } from '../../leave/leave.service';

/**
 * A representative slice of the versioned public API (step 3.3) — see
 * `v1-employees.controller.ts`'s doc comment. Requires the BROADER
 * `leave.approve` scope (not `leave.read`) since an API key has no linked
 * `Employee`/"self" the way a JWT-authenticated user does —
 * `LeaveService.list`/`.findById`'s own self-vs-manage split only makes
 * sense for a real user, so this always calls them with
 * `canManageOthers: true`.
 */
@ApiTags('v1')
@ApiSecurity('ApiKeyAuth')
@Controller('v1/leave')
export class V1LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('requests')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard)
  @RequireFeature(FEATURE_FLAGS.API_ACCESS)
  @RequirePermissions(PERMISSIONS.LEAVE_APPROVE)
  @ApiOperation({ summary: 'List leave requests for the authenticated tenant' })
  list(@Query('employeeId') employeeId?: string, @Query('branchId') branchId?: string) {
    return this.leave.list(this.tenantContext.getTx(), '', true, this.tenantContext.getBranchIds(), { employeeId, branchId });
  }

  @Get('requests/:id')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard)
  @RequireFeature(FEATURE_FLAGS.API_ACCESS)
  @RequirePermissions(PERMISSIONS.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Get one leave request by id' })
  findOne(@Param('id') id: string) {
    return this.leave.findById(this.tenantContext.getTx(), id, '', true, this.tenantContext.getBranchIds());
  }
}
