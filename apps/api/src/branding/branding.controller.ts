import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Prisma, TenantDomain } from '@hrm/db';
import {
  FEATURE_FLAGS,
  PERMISSIONS,
  requestDomainRequestSchema,
  RequestDomainInput,
  updateBrandingRequestSchema,
  UpdateBrandingInput,
  updateRebrandRequestSchema,
  UpdateRebrandInput,
} from '@hrm/shared';
import { AllowAnonymous } from '../auth/decorators/allow-anonymous.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { FeatureFlagGuard } from '../licensing/feature-flag.guard';
import { FeatureFlagResolutionService } from '../licensing/feature-flag-resolution.service';
import { RequireFeature } from '../licensing/require-feature.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { BrandingResolutionService, EffectiveBranding } from './branding-resolution.service';
import { BrandingService } from './branding.service';

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Per-tenant branding — see docs/conventions/white-label.md. `GET
 * /branding` and the logo/favicon downloads are deliberately
 * `@AllowAnonymous()`: the pre-login screen needs to render a tenant's
 * branding before any user is authenticated, and tenant resolution has
 * already happened by the time any route on this controller runs (see
 * /CLAUDE.md § Conventions → Tenant resolution). Every MUTATION is gated
 * on `branding.manage` (TENANT_ADMIN only) + audited.
 */
@Controller('branding')
export class BrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly resolution: BrandingResolutionService,
    private readonly featureFlags: FeatureFlagResolutionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @AllowAnonymous()
  async getPublic() {
    const tenantId = this.requireTenantId();
    const tx = this.tenantContext.getTx();
    const effective = await this.resolution.resolve(tx, tenantId);
    const showPoweredBy = await this.resolveShowPoweredBy(tx, tenantId, effective.fullRebrandEnabled);
    return this.toPublicDto(effective, showPoweredBy);
  }

  @Get('settings')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  async getSettings() {
    const tenantId = this.requireTenantId();
    const tx = this.tenantContext.getTx();
    const row = await this.branding.getRow(tx, tenantId);
    const domain = await this.branding.getDomain(tenantId);
    const flags = await this.featureFlags.resolve(tx, tenantId);
    return {
      productName: row?.productName ?? null,
      hasLogo: Boolean(row?.logoStorageKey),
      hasFavicon: Boolean(row?.faviconStorageKey),
      primaryColor: row?.primaryColor ?? null,
      secondaryColor: row?.secondaryColor ?? null,
      accentColor: row?.accentColor ?? null,
      loginHeadline: row?.loginHeadline ?? null,
      loginSubtext: row?.loginSubtext ?? null,
      emailFromName: row?.emailFromName ?? null,
      emailFromAddress: row?.emailFromAddress ?? null,
      fullRebrandEnabled: row?.fullRebrandEnabled ?? false,
      fullRebrandEntitled: flags.flags.includes(FEATURE_FLAGS.FULL_REBRAND),
      domain: domain ? this.toDomainDto(domain) : null,
    };
  }

  @Put()
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @AuditLog('TenantBranding', 'UPDATE')
  update(@Body(new ZodValidationPipe(updateBrandingRequestSchema)) body: UpdateBrandingInput) {
    return this.branding.update(this.tenantContext.getTx(), this.requireTenantId(), this.tenantContext.userId, body);
  }

  /**
   * The DEEPER lifetime/on-prem rebrand capability — gated behind
   * `@RequireFeature(FULL_REBRAND)` (ENTERPRISE-only in EDITION_FEATURES)
   * on top of the ordinary `branding.manage` permission check, reusing
   * the EXACT existing entitlement mechanism (0.6) rather than a
   * bespoke check — see docs/conventions/white-label.md.
   */
  @Put('rebrand')
  @UseInterceptors(PermissionsGuard, FeatureFlagGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @RequireFeature(FEATURE_FLAGS.FULL_REBRAND)
  @AuditLog('TenantBranding', 'UPDATE_REBRAND')
  updateRebrand(@Body(new ZodValidationPipe(updateRebrandRequestSchema)) body: UpdateRebrandInput) {
    return this.branding.updateRebrand(this.tenantContext.getTx(), this.requireTenantId(), this.tenantContext.userId, body.enabled);
  }

  @Post('logo')
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }), AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @AuditLog('TenantBranding', 'UPLOAD_LOGO')
  async uploadLogo(@UploadedFile() file: Express.Multer.File | undefined) {
    this.requireFile(file);
    return this.branding.uploadLogo(this.tenantContext.getTx(), this.requireTenantId(), this.tenantContext.userId, file);
  }

  @Post('favicon')
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } }), AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @AuditLog('TenantBranding', 'UPLOAD_FAVICON')
  async uploadFavicon(@UploadedFile() file: Express.Multer.File | undefined) {
    this.requireFile(file);
    return this.branding.uploadFavicon(this.tenantContext.getTx(), this.requireTenantId(), this.tenantContext.userId, file);
  }

  @Get('logo')
  @AllowAnonymous()
  async downloadLogo(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { body, contentType } = await this.branding.downloadLogo(this.tenantContext.getTx(), this.requireTenantId());
    res.set({ 'Content-Type': contentType ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=300' });
    return new StreamableFile(body);
  }

  @Get('favicon')
  @AllowAnonymous()
  async downloadFavicon(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { body, contentType } = await this.branding.downloadFavicon(this.tenantContext.getTx(), this.requireTenantId());
    res.set({ 'Content-Type': contentType ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=300' });
    return new StreamableFile(body);
  }

  @Post('domain')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @AuditLog('TenantDomain', 'REQUEST')
  async requestDomain(@Body(new ZodValidationPipe(requestDomainRequestSchema)) body: RequestDomainInput) {
    const result = await this.branding.requestDomain(this.requireTenantId(), this.tenantContext.userId, body.domain);
    return { ...this.toDomainDto(result.domain), dnsRecordName: result.dnsRecordName, dnsRecordValue: result.dnsRecordValue };
  }

  @Delete('domain/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  @AuditLog('TenantDomain', 'DELETE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDomain(@Param('id') id: string) {
    await this.branding.deleteDomain(this.requireTenantId(), id);
  }

  private async resolveShowPoweredBy(tx: Prisma.TransactionClient, tenantId: string, fullRebrandEnabled: boolean): Promise<boolean> {
    if (!fullRebrandEnabled) {
      return true;
    }
    const flags = await this.featureFlags.resolve(tx, tenantId);
    return !flags.flags.includes(FEATURE_FLAGS.FULL_REBRAND);
  }

  private toPublicDto(effective: EffectiveBranding, showPoweredBy: boolean) {
    return {
      productName: effective.productName,
      hasLogo: effective.logoStorageKey !== null,
      hasFavicon: effective.faviconStorageKey !== null,
      primaryColor: effective.primaryColor,
      secondaryColor: effective.secondaryColor,
      accentColor: effective.accentColor,
      loginHeadline: effective.loginHeadline,
      loginSubtext: effective.loginSubtext,
      showPoweredBy,
    };
  }

  private toDomainDto(domain: TenantDomain) {
    return {
      id: domain.id,
      domain: domain.domain,
      verificationStatus: domain.verificationStatus,
      certStatus: domain.certStatus,
      certProvisionedAt: domain.certProvisionedAt?.toISOString() ?? null,
      certExpiresAt: domain.certExpiresAt?.toISOString() ?? null,
      createdAt: domain.createdAt.toISOString(),
    };
  }

  private requireFile(file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
    if (!file) {
      throw new BadRequestException('A "file" multipart field is required.');
    }
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }
}
