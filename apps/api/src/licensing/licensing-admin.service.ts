import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { prisma } from '@hrm/db';
import type { FlagOverrideInput, IssueLicenseInput, LicensePayload, RevokeLicenseInput } from '@hrm/shared';
import { LicenseSigningService } from './license-signing.service';
import { LICENSING_EVENTS } from './licensing-events';

/**
 * The vendor/platform side of licensing: issuing and revoking license
 * files, and toggling per-tenant feature-flag overrides — deliberately
 * cross-tenant, since a single vendor deployment issues licenses for many
 * customer tenants. Reached only through `LicensingAdminController`'s
 * `@PlatformRoute()` endpoints (see /CLAUDE.md § Conventions → Platform
 * context), which is why this service queries through `prisma` — the
 * owner/admin client — directly rather than a tenant-scoped transaction:
 * a platform request opens no `withTenantContext` transaction at all
 * (`TenantContextService.getTx()` throws unconditionally for one), and
 * these operations are legitimately cross-tenant admin/bootstrap
 * operations, the same class of usage `packages/db/prisma/seed.ts`
 * already makes of this client. `FORCE ROW LEVEL SECURITY` on every table
 * this touches means only this admin path (and seeding/tests) can bypass
 * tenant isolation — no normal tenant request can, regardless of this
 * service's existence.
 */
@Injectable()
export class LicensingAdminService {
  constructor(
    private readonly signing: LicenseSigningService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async issue(input: IssueLicenseInput): Promise<{ licenseFile: string }> {
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { name: true } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${input.tenantId}" was not found.`);
    }

    const payload: LicensePayload = {
      tenantId: input.tenantId,
      tenantName: tenant.name,
      edition: input.edition,
      enabledFlags: input.enabledFlags,
      seatCap: input.seatCap,
      ...(input.challenge ? { challenge: input.challenge } : {}),
    };
    const licenseFile = this.signing.sign(payload, input.expiresInDays);

    this.eventEmitter.emit(LICENSING_EVENTS.ISSUED, {
      type: LICENSING_EVENTS.ISSUED,
      tenantId: input.tenantId,
      edition: input.edition,
      seatCap: input.seatCap,
      expiresInDays: input.expiresInDays ?? null,
      offline: Boolean(input.challenge),
    });

    return { licenseFile };
  }

  async revoke(input: RevokeLicenseInput): Promise<{ revokedCount: number }> {
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${input.tenantId}" was not found.`);
    }

    const { count } = await prisma.license.updateMany({
      where: { tenantId: input.tenantId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    this.eventEmitter.emit(LICENSING_EVENTS.REVOKED, {
      type: LICENSING_EVENTS.REVOKED,
      tenantId: input.tenantId,
      reason: input.reason ?? null,
      revokedCount: count,
    });

    return { revokedCount: count };
  }

  async setFlagOverride(tenantId: string, input: FlagOverrideInput): Promise<void> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${tenantId}" was not found.`);
    }

    await prisma.tenantFeatureFlagOverride.upsert({
      where: { tenantId_flagKey: { tenantId, flagKey: input.flagKey } },
      update: { enabled: input.enabled },
      create: { tenantId, flagKey: input.flagKey, enabled: input.enabled },
    });

    this.eventEmitter.emit(LICENSING_EVENTS.FLAG_OVERRIDE_SET, {
      type: LICENSING_EVENTS.FLAG_OVERRIDE_SET,
      tenantId,
      flagKey: input.flagKey,
      enabled: input.enabled,
    });
  }
}
