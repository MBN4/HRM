import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseInterceptors } from '@nestjs/common';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  setPushTokenSchema,
  PERMISSIONS,
  type ChangePasswordInput,
  type LoginInput,
  type RefreshInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type SetPushTokenInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Priority } from '../resilience/load-shedding/priority.decorator';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AllowAnonymous } from './decorators/allow-anonymous.decorator';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('login')
  @AllowAnonymous()
  @Priority('CRITICAL')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput) {
    return this.auth.login(this.requireTenantId(), this.tenantContext.getTx(), body);
  }

  @Post('refresh')
  @AllowAnonymous()
  @Priority('CRITICAL')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    return this.auth.refresh(this.requireTenantId(), body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    await this.auth.logout(this.requireTenantId(), this.requireUserId(), body.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll() {
    await this.auth.logoutAll(this.requireTenantId(), this.requireUserId());
  }

  @Get('me')
  me(@CurrentTenant() ctx: ReturnType<TenantContextService['getContext']>) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      roles: ctx.roles,
      permissions: ctx.permissions,
      branchIds: ctx.branchIds,
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(@Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput) {
    await this.auth.changePassword(this.requireTenantId(), this.tenantContext.getTx(), this.requireUserId(), body);
  }

  /**
   * Registers/clears the caller's own push-notification device token (step
   * 1.4, mobile ESS) — see `User.pushToken`'s doc comment in
   * `schema.prisma`. Deliberately inline here (no dedicated service
   * method), the same "self-contained, no bigger change" posture `/auth/me`
   * itself already takes for a one-column self-mutation.
   */
  @Post('push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPushToken(@Body(new ZodValidationPipe(setPushTokenSchema)) body: SetPushTokenInput) {
    await this.tenantContext.getTx().user.update({ where: { id: this.requireUserId() }, data: { pushToken: body.pushToken } });
  }

  @Post('request-password-reset')
  @AllowAnonymous()
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestPasswordReset(@Body(new ZodValidationPipe(requestPasswordResetSchema)) body: RequestPasswordResetInput) {
    await this.auth.requestPasswordReset(this.requireTenantId(), this.tenantContext.getTx(), body);
  }

  @Post('reset-password')
  @AllowAnonymous()
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput) {
    await this.auth.resetPassword(this.requireTenantId(), this.tenantContext.getTx(), body);
  }

  /**
   * Reference route for `@RequirePermissions()` + `PermissionsGuard` — see
   * /CLAUDE.md § Conventions → RBAC. Requires `role.manage`, which none of
   * the seeded system roles except TENANT_ADMIN hold by default.
   */
  @Get('rbac-demo')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  rbacDemo() {
    return { ok: true };
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: auth routes always run within a resolved tenant.');
    }
    return tenantId;
  }

  private requireUserId(): string {
    const userId = this.tenantContext.userId;
    if (!userId) {
      throw new Error('Unreachable: this route requires authentication.');
    }
    return userId;
  }
}
