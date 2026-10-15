import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  kioskBiometricIdentifySchema,
  kioskClockSchema,
  kioskIdentifySchema,
  type KioskBiometricIdentifyInput,
  type KioskClockInput,
  type KioskIdentifyInput,
} from '@hrm/shared';
import { KioskRoute } from '../auth/kiosk/kiosk-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { MAX_KIOSK_PHOTO_BYTES } from './kiosk.constants';
import { KioskPunchService, KioskRequestMeta } from './kiosk-punch.service';

/**
 * The device-facing surface — everything a kiosk terminal can do, and NOTHING else: `GET /kiosk/me` (its
 * own name/branch/options, so the screen can render), identify (PIN or biometric) and clock.
 *
 * `@KioskRoute()` at class level means (see its doc): only a kiosk token authenticates here, and a kiosk
 * token authenticates nowhere else. NO `PermissionsGuard` is used on purpose — a kiosk holds no
 * permissions; its authority is entirely "this device, this branch", enforced in `KioskPunchService`.
 * There is no audit decorator either: the punch/failure audit rows carry the kiosk + employee identity
 * and are written by the service (the generic interceptor only knows a `userId`, which a kiosk lacks).
 */
@KioskRoute()
@Controller('kiosk')
export class KioskDeviceController {
  constructor(
    private readonly punches: KioskPunchService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('me')
  async me() {
    const kiosk = this.requireKiosk();
    // Its own branch only (the one it is bound to) — the screen shows the location + renders times in its timezone.
    const branch = await this.tenantContext
      .getTx()
      .branch.findUnique({ where: { id: kiosk.branchId }, select: { name: true, timezone: true } });
    return {
      id: kiosk.id,
      name: kiosk.name,
      branchId: kiosk.branchId,
      branchName: branch?.name ?? null,
      timezone: branch?.timezone ?? 'UTC',
      requirePhoto: kiosk.requirePhoto,
      biometricEnabled: kiosk.biometricEnabled,
    };
  }

  @Post('identify')
  identify(
    @Body(new ZodValidationPipe(kioskIdentifySchema)) body: KioskIdentifyInput,
    @Req() req: Request,
  ) {
    return this.punches.identify(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireKiosk(),
      body,
      this.meta(req),
    );
  }

  @Post('identify/biometric')
  identifyBiometric(
    @Body(new ZodValidationPipe(kioskBiometricIdentifySchema)) body: KioskBiometricIdentifyInput,
    @Req() req: Request,
  ) {
    return this.punches.identifyBiometric(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireKiosk(),
      body,
      this.meta(req),
    );
  }

  /** Multipart: `ticket` + `action` text fields, plus an optional `photo` image. */
  @Post('clock')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_KIOSK_PHOTO_BYTES } }))
  clock(
    @Body(new ZodValidationPipe(kioskClockSchema)) body: KioskClockInput,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.punches.punch(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireKiosk(),
      body,
      photo
        ? {
            buffer: photo.buffer,
            mimeType: photo.mimetype,
            fileName: sanitizeFileName(photo.originalname),
          }
        : undefined,
      this.meta(req),
    );
  }

  private meta(req: Request): KioskRequestMeta {
    return {
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    };
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }

  private requireKiosk() {
    const kiosk = this.tenantContext.kiosk;
    if (!kiosk) {
      // Unreachable via HTTP (TenantScopeInterceptor rejects first); guards a future misconfiguration.
      throw new BadRequestException('No kiosk device is bound to this request.');
    }
    return kiosk;
  }
}

/** A client-supplied file name only ever becomes part of an object-storage key — keep it to a safe charset. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return cleaned || 'photo.jpg';
}
