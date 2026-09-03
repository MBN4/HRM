import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  platformEnrollmentTokenRequestSchema,
  platformLoginRequestSchema,
  platformMfaEnrollConfirmRequestSchema,
  platformMfaVerifyRequestSchema,
  platformRefreshRequestSchema,
  type PlatformEnrollmentTokenInput,
  type PlatformLoginInput,
  type PlatformMfaEnrollConfirmInput,
  type PlatformMfaVerifyInput,
  type PlatformRefreshInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Priority } from '../../resilience/load-shedding/priority.decorator';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AllowAnonymousPlatform } from './allow-anonymous-platform.decorator';
import { PlatformAuthService } from './platform-auth.service';

/**
 * The vendor super-admin console's own login surface — see
 * docs/conventions/vendor-console.md → Mandatory MFA. Every route here is
 * `@PlatformRoute()`; only THIS controller (plus refresh/logout) is
 * `@AllowAnonymousPlatform()` — every other platform route in the system
 * requires a fully authenticated, MFA-verified session minted here.
 */
@Controller('platform/auth')
@PlatformRoute()
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('login')
  @AllowAnonymousPlatform()
  @Priority('CRITICAL')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(platformLoginRequestSchema)) body: PlatformLoginInput) {
    return this.auth.login(body);
  }

  @Post('mfa/enroll')
  @AllowAnonymousPlatform()
  @HttpCode(HttpStatus.OK)
  startEnrollment(@Body(new ZodValidationPipe(platformEnrollmentTokenRequestSchema)) body: PlatformEnrollmentTokenInput) {
    return this.auth.startEnrollment(body.enrollmentToken);
  }

  @Post('mfa/enroll/confirm')
  @AllowAnonymousPlatform()
  @HttpCode(HttpStatus.OK)
  confirmEnrollment(@Body(new ZodValidationPipe(platformMfaEnrollConfirmRequestSchema)) body: PlatformMfaEnrollConfirmInput) {
    return this.auth.confirmEnrollment(body);
  }

  @Post('mfa/verify')
  @AllowAnonymousPlatform()
  @Priority('CRITICAL')
  @HttpCode(HttpStatus.OK)
  verifyMfa(@Body(new ZodValidationPipe(platformMfaVerifyRequestSchema)) body: PlatformMfaVerifyInput) {
    return this.auth.verifyMfa(body);
  }

  @Post('refresh')
  @AllowAnonymousPlatform()
  @Priority('CRITICAL')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodValidationPipe(platformRefreshRequestSchema)) body: PlatformRefreshInput) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body(new ZodValidationPipe(platformRefreshRequestSchema)) body: PlatformRefreshInput) {
    await this.auth.logout(body.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll() {
    await this.auth.logoutAll(this.requirePlatformAdminId());
  }

  @Get('me')
  me() {
    return { platformAdminId: this.requirePlatformAdminId(), role: this.tenantContext.platformRole };
  }

  private requirePlatformAdminId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
