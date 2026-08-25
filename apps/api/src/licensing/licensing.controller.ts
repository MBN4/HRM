import { BadRequestException, Body, Controller, Get, Post, UseInterceptors } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  activationCompleteRequestSchema,
  ActivationCompleteInput,
  FEATURE_FLAGS,
  PERMISSIONS,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { FeatureFlagResolutionService } from './feature-flag-resolution.service';
import { FeatureFlagGuard } from './feature-flag.guard';
import { InvalidLicenseError } from './license-verification.service';
import { LicenseActivationService } from './license-activation.service';
import { LICENSING_EVENTS } from './licensing-events';
import { RequireFeature } from './require-feature.decorator';

/**
 * Tenant-scoped licensing routes: `entitlements` is the demo/proof
 * endpoint for the whole resolution pipeline; `activation/*` is the
 * on-prem instance's own side of the challenge-response flow (see
 * /CLAUDE.md § Conventions → Licensing / feature flags); `demo/*` is the
 * reference usage of `@RequireFeature`, the same role
 * `GET /auth/rbac-demo` and `GET /tenancy/permission-field-demo` play for
 * their respective patterns.
 */
@Controller('licensing')
export class LicensingController {
  constructor(
    private readonly resolution: FeatureFlagResolutionService,
    private readonly activation: LicenseActivationService,
    private readonly tenantContext: TenantContextService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Get('entitlements')
  async entitlements() {
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId;
    if (!tenantId) {
      return { mode: this.resolution.mode(), edition: null, flags: [], seatCap: null, blocked: true };
    }

    const result = await this.resolution.resolve(tx, tenantId);
    if (result.seatCap?.overCap) {
      this.eventEmitter.emit(LICENSING_EVENTS.SEAT_CAP_EXCEEDED, {
        type: LICENSING_EVENTS.SEAT_CAP_EXCEEDED,
        tenantId,
        mode: result.mode,
        ...result.seatCap,
      });
    }
    return result;
  }

  @Post('activation/challenge')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LICENSE_MANAGE)
  async createActivationChallenge() {
    this.activation.assertLifetimeMode(this.resolution.mode());
    const tenantId = this.tenantContext.getContext().tenantId!;
    return this.activation.createChallenge(tenantId);
  }

  @Post('activation/complete')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LICENSE_MANAGE)
  async completeActivation(@Body(new ZodValidationPipe(activationCompleteRequestSchema)) body: ActivationCompleteInput) {
    this.activation.assertLifetimeMode(this.resolution.mode());
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId!;
    try {
      return await this.activation.complete(tx, tenantId, body.licenseFile);
    } catch (error) {
      if (error instanceof InvalidLicenseError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Reference usage of `@RequireFeature()` — see require-feature.decorator.ts. */
  @Get('demo/advanced-reporting')
  @UseInterceptors(FeatureFlagGuard)
  @RequireFeature(FEATURE_FLAGS.ADVANCED_REPORTING)
  advancedReportingDemo(): { ok: true } {
    return { ok: true };
  }
}
