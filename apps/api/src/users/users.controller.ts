import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  createUserSchema,
  listUsersQuerySchema,
  PERMISSIONS,
  updateUserAccessSchema,
  type CreateUserInput,
  type ListUsersQuery,
  type UpdateUserAccessInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { UserActor, UsersService } from './users.service';

/**
 * Tenant user / team access management (step 7.1) — see
 * docs/conventions/user-management.md. Every route requires `user.manage`
 * (deny-by-default via `PermissionsGuard`); the mutations are audited. No
 * DELETE route exists on purpose: users are deactivated, never removed.
 */
@Controller('users')
@UseInterceptors(PermissionsGuard)
@RequirePermissions(PERMISSIONS.USER_MANAGE)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery) {
    return this.users.list(this.tenantContext.getTx(), this.actor(), query);
  }

  @Get('assignable-roles')
  assignableRoles() {
    return this.users.assignableRoles(this.tenantContext.getTx(), this.actor());
  }

  @Post()
  @UseInterceptors(AuditInterceptor)
  @AuditLog('User', 'CREATE')
  create(@Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput) {
    return this.users.create(this.tenantContext.getTx(), this.requireTenantId(), this.actor(), body);
  }

  @Patch(':id/access')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('User', 'UPDATE_ACCESS')
  updateAccess(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(updateUserAccessSchema)) body: UpdateUserAccessInput) {
    return this.users.updateAccess(this.tenantContext.getTx(), this.requireTenantId(), this.actor(), id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AuditInterceptor)
  @AuditLog('User', 'DEACTIVATE')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.deactivate(this.tenantContext.getTx(), this.requireTenantId(), this.actor(), id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AuditInterceptor)
  @AuditLog('User', 'REACTIVATE')
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.reactivate(this.tenantContext.getTx(), this.actor(), id);
  }

  @Post(':id/regenerate-temp-password')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AuditInterceptor)
  @AuditLog('User', 'REGENERATE_TEMP_PASSWORD')
  regenerateTemporaryPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.regenerateTemporaryPassword(this.tenantContext.getTx(), this.requireTenantId(), this.actor(), id);
  }

  private actor(): UserActor {
    const userId = this.tenantContext.userId;
    if (!userId) {
      throw new Error('Unreachable: this controller requires authentication.');
    }
    return { userId, permissions: this.tenantContext.getPermissions(), branchIds: this.tenantContext.getBranchIds() };
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: tenant routes always run within a resolved tenant.');
    }
    return tenantId;
  }
}
