import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FEATURE_FLAGS, PERMISSIONS, ssoConfigInputSchema, updateSsoConfigEnabledSchema, type SsoConfigInput } from '@hrm/shared';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FeatureFlagGuard } from '../../licensing/feature-flag.guard';
import { RequireFeature } from '../../licensing/require-feature.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AllowAnonymous } from '../decorators/allow-anonymous.decorator';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { PermissionsGuard } from '../guards/permissions.guard';
import { SsoService } from './sso.service';

/**
 * Finishes the SSO seam abstracted since 0.4. Two anonymous, feature-flag-
 * gated routes carry the actual federated-login redirect dance
 * (`/login`/`/callback`) — `@AllowAnonymous()` because a browser arriving
 * here has no JWT yet, exactly like `/auth/login` itself; both still run
 * inside the caller's normal tenant-resolved, RLS-scoped transaction (the
 * request lands on the SAME tenant subdomain/host both times, so no
 * tenant-id needs to travel through `state`). Two admin routes
 * (`GET`/`PUT /config`, `POST /config/enabled`) manage the per-tenant IdP
 * configuration, gated by `sso.manage` (+ `FEATURE_FLAGS.SSO` on any
 * MUTATION — an ENTERPRISE-only tenant literally cannot save/enable a
 * config, per this step's brief).
 */
@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('login')
  @AllowAnonymous()
  @UseInterceptors(FeatureFlagGuard)
  @RequireFeature(FEATURE_FLAGS.SSO)
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { redirectUrl } = await this.sso.beginLogin(this.tenantContext.getTx(), this.requireTenantId(), this.callbackUrl(req));
    res.redirect(302, redirectUrl);
  }

  /** OIDC's authorization-code redirect lands here as a GET (`?code=...&state=...`). */
  @Get('callback')
  @AllowAnonymous()
  @UseInterceptors(FeatureFlagGuard)
  @RequireFeature(FEATURE_FLAGS.SSO)
  @HttpCode(HttpStatus.OK)
  callback(@Req() req: Request, @Query() query: Record<string, string>) {
    return this.sso.handleCallback(this.tenantContext.getTx(), this.requireTenantId(), this.callbackUrl(req), query);
  }

  /** SAML's HTTP-POST binding ACS lands here as a POST (`SAMLResponse`/`RelayState` form fields) — routes to the SAME `handleCallback`, which throws for SAML (see `SamlAuthProvider`'s doc comment). */
  @Post('callback')
  @AllowAnonymous()
  @UseInterceptors(FeatureFlagGuard)
  @RequireFeature(FEATURE_FLAGS.SSO)
  @HttpCode(HttpStatus.OK)
  callbackPost(@Req() req: Request, @Body() body: Record<string, string>) {
    return this.sso.handleCallback(this.tenantContext.getTx(), this.requireTenantId(), this.callbackUrl(req), body);
  }

  @Get('config')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SSO_MANAGE)
  async getConfig() {
    const row = await this.sso.getConfig(this.tenantContext.getTx(), this.requireTenantId());
    if (!row) {
      return null;
    }
    return { protocol: row.protocol, enabled: row.enabled, config: this.sso.redactConfig(row.config) };
  }

  @Put('config')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.SSO)
  @RequirePermissions(PERMISSIONS.SSO_MANAGE)
  @AuditLog('SsoConfig', 'UPSERT')
  async putConfig(@Body(new ZodValidationPipe(ssoConfigInputSchema)) body: SsoConfigInput) {
    const row = await this.sso.upsertConfig(this.tenantContext.getTx(), this.requireTenantId(), body);
    return { protocol: row.protocol, enabled: row.enabled, config: this.sso.redactConfig(row.config) };
  }

  @Post('config/enabled')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.SSO)
  @RequirePermissions(PERMISSIONS.SSO_MANAGE)
  @AuditLog('SsoConfig', 'SET_ENABLED')
  @HttpCode(HttpStatus.OK)
  async setEnabled(@Body(new ZodValidationPipe(updateSsoConfigEnabledSchema)) body: { enabled: boolean }) {
    const row = await this.sso.setEnabled(this.tenantContext.getTx(), this.requireTenantId(), body.enabled);
    return { protocol: row.protocol, enabled: row.enabled };
  }

  private callbackUrl(req: Request): string {
    return `${req.protocol}://${req.get('host')}/auth/sso/callback`;
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: SSO routes always run within a resolved tenant.');
    }
    return tenantId;
  }
}
