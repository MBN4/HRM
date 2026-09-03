import { randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { BiometricDeviceRegistration, Prisma } from '@hrm/db';
import type { RegisterBiometricDeviceInput } from '@hrm/shared';
import { HashingService } from '../../common/hashing/hashing.service';

/**
 * Formalizes the 1.3 biometric seam with a real per-tenant device registry
 * (step 3.3) — see `biometric-device.controller.ts` for the ingestion
 * endpoint this backs. `BiometricDeviceAdapter`/`ManualBiometricDeviceAdapter`
 * (`apps/api/src/attendance/devices/`) are completely untouched: this
 * service only decides "is this device allowed to push punches for this
 * tenant right now", never how a punch is translated into a clock event.
 */
@Injectable()
export class BiometricDeviceService {
  constructor(private readonly hashing: HashingService) {}

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<BiometricDeviceRegistration[]> {
    return tx.biometricDeviceRegistration.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  async register(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: RegisterBiometricDeviceInput,
  ): Promise<{ registration: BiometricDeviceRegistration; secret: string }> {
    const secret = randomBytes(24).toString('base64url');
    const registration = await tx.biometricDeviceRegistration.create({
      data: { tenantId, deviceId: input.deviceId, name: input.name, hashedSecret: await this.hashing.hash(secret) },
    });
    return { registration, secret };
  }

  async setStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deviceId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<BiometricDeviceRegistration> {
    return tx.biometricDeviceRegistration.update({ where: { tenantId_deviceId: { tenantId, deviceId } }, data: { status } });
  }

  /** Verifies the device's presented secret and bumps `lastSeenAt`; throws if the device is unknown, disabled, or the secret is wrong — no `missing_ok`, this codebase's consistent posture. */
  async authenticateDevice(tx: Prisma.TransactionClient, tenantId: string, deviceId: string, presentedSecret: string): Promise<void> {
    const registration = await tx.biometricDeviceRegistration.findUnique({ where: { tenantId_deviceId: { tenantId, deviceId } } });
    if (!registration || registration.status !== 'ACTIVE') {
      throw new UnauthorizedException('Unknown or disabled device.');
    }
    if (!(await this.hashing.verify(registration.hashedSecret, presentedSecret))) {
      throw new UnauthorizedException('Invalid device secret.');
    }
    await tx.biometricDeviceRegistration.update({ where: { id: registration.id }, data: { lastSeenAt: new Date() } });
  }
}
