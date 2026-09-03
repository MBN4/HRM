import { Body, Controller, Get, Headers, Inject, Param, Post, UnauthorizedException, UseInterceptors } from '@nestjs/common';
import {
  biometricPunchIngestSchema,
  registerBiometricDeviceSchema,
  PERMISSIONS,
  type BiometricPunchIngestInput,
  type RegisterBiometricDeviceInput,
} from '@hrm/shared';
import { BIOMETRIC_DEVICE_ADAPTER } from '../../attendance/devices/biometric-device.interface';
import type { BiometricDeviceAdapter } from '../../attendance/devices/biometric-device.interface';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AllowAnonymous } from '../../auth/decorators/allow-anonymous.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { BiometricDeviceService } from './biometric-device.service';

/**
 * Admin CRUD (JWT + `integration.manage`) plus the real device-facing
 * ingestion route (step 3.3). The ingestion route is `@AllowAnonymous()` —
 * a physical device is not a logged-in user — but STILL runs through the
 * normal tenant-resolution pipeline (a device authenticates to its
 * tenant via the `X-Tenant-Id` header strategy 0.3 already built for
 * exactly this "no per-tenant hostname" case) and the normal RLS-scoped
 * transaction; `X-Device-Secret` is this route's OWN, additional
 * per-device credential check, verified by `BiometricDeviceService`
 * before `BIOMETRIC_DEVICE_ADAPTER` (the UNCHANGED 1.3 seam) is ever
 * called.
 */
@Controller('integrations/biometric')
export class BiometricDeviceController {
  constructor(
    private readonly devices: BiometricDeviceService,
    private readonly tenantContext: TenantContextService,
    @Inject(BIOMETRIC_DEVICE_ADAPTER) private readonly biometricDevice: BiometricDeviceAdapter,
  ) {}

  @Get('devices')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  list() {
    return this.devices.list(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Post('devices')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  @AuditLog('BiometricDeviceRegistration', 'REGISTER')
  async register(@Body(new ZodValidationPipe(registerBiometricDeviceSchema)) body: RegisterBiometricDeviceInput) {
    const { registration, secret } = await this.devices.register(this.tenantContext.getTx(), this.requireTenantId(), body);
    // Shown exactly once, the same posture every other generated secret in this step takes.
    return { ...registration, secret };
  }

  @Post('devices/:deviceId/disable')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  @AuditLog('BiometricDeviceRegistration', 'DISABLE')
  disable(@Param('deviceId') deviceId: string) {
    return this.devices.setStatus(this.tenantContext.getTx(), this.requireTenantId(), deviceId, 'DISABLED');
  }

  @Post('devices/:deviceId/punches')
  @AllowAnonymous()
  async ingestPunch(
    @Param('deviceId') deviceId: string,
    @Headers('x-device-secret') deviceSecret: string | undefined,
    @Body(new ZodValidationPipe(biometricPunchIngestSchema)) body: BiometricPunchIngestInput,
  ) {
    if (!deviceSecret) {
      throw new UnauthorizedException('Missing X-Device-Secret header.');
    }
    const tenantId = this.requireTenantId();
    const tx = this.tenantContext.getTx();
    await this.devices.authenticateDevice(tx, tenantId, deviceId, deviceSecret);
    return this.biometricDevice.handlePunch(tx, tenantId, {
      employeeCode: body.employeeCode,
      direction: body.direction,
      timestamp: body.timestamp,
      deviceId,
    });
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }
}
