import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import type { Prisma } from '@hrm/db';
import type { LicensePayload } from '@hrm/shared';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { InvalidLicenseError, LicenseVerificationService } from './license-verification.service';
import { LICENSING_EVENTS } from './licensing-events';

const CHALLENGE_TTL_SECONDS = 30 * 60;

function challengeKey(tenantId: string): string {
  return `license:activation-challenge:${tenantId}`;
}

/**
 * Tenant-scoped side of the license activation flow (see /CLAUDE.md §
 * Conventions → Licensing / feature flags → Offline activation for the
 * full challenge-response design). This is the on-prem INSTANCE's own
 * side: it generates a challenge for an operator to send to the vendor
 * out-of-band, and later applies whatever signed license file the vendor
 * hands back — as opposed to `LicensingAdminService`, which is the
 * vendor's side (issuing/revoking, behind the platform seam).
 *
 * The pending challenge lives in Redis with a TTL, the same "opaque,
 * short-lived, per-tenant token" shape `RateLimiterService`/`TokenService`
 * already use elsewhere in this codebase — not a DB table, since it's
 * transient by nature and never needs to survive a Postgres backup/restore.
 */
@Injectable()
export class LicenseActivationService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly verification: LicenseVerificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Step 1 of the offline flow: generate a nonce bound to this tenant and
   * hand it to the operator to relay to the vendor (who embeds it in the
   * license file they issue — see `LicensingAdminService.issue`). Step 2
   * of the online flow doesn't exist — a direct license file can be
   * applied via `complete()` with no challenge ever generated.
   */
  async createChallenge(tenantId: string): Promise<{ challenge: string }> {
    const challenge = randomUUID();
    await this.redis.set(challengeKey(tenantId), challenge, 'EX', CHALLENGE_TTL_SECONDS);
    return { challenge };
  }

  /**
   * Step 3 (offline) / the only step (online): verify the signature, bind
   * it to the calling tenant, and — if a challenge is currently pending
   * for this tenant — require the file's `challenge` claim to match it
   * (proving this specific file answers this specific request, not a
   * replay against a different install). Activating supersedes any prior
   * ACTIVE license for the tenant.
   */
  async complete(tx: Prisma.TransactionClient, tenantId: string, licenseFile: string): Promise<LicensePayload> {
    const verified = this.verification.verify(licenseFile);

    if (verified.payload.tenantId !== tenantId) {
      throw new InvalidLicenseError('This license file was not issued for the calling tenant.');
    }

    const pendingChallenge = await this.redis.get(challengeKey(tenantId));
    if (pendingChallenge) {
      if (verified.payload.challenge !== pendingChallenge) {
        throw new InvalidLicenseError('This license file does not answer the pending activation challenge.');
      }
      await this.redis.del(challengeKey(tenantId));
    }

    await tx.license.updateMany({ where: { tenantId, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    await tx.license.create({
      data: {
        tenantId,
        edition: verified.payload.edition,
        enabledFlags: verified.payload.enabledFlags,
        seatCap: verified.payload.seatCap,
        signedToken: licenseFile,
        issuedAt: verified.issuedAt,
        expiresAt: verified.expiresAt,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });

    this.eventEmitter.emit(LICENSING_EVENTS.ACTIVATION_COMPLETED, {
      type: LICENSING_EVENTS.ACTIVATION_COMPLETED,
      tenantId,
      edition: verified.payload.edition,
      seatCap: verified.payload.seatCap,
    });

    return verified.payload;
  }

  assertLifetimeMode(mode: string): void {
    if (mode !== 'lifetime') {
      throw new BadRequestException('License activation only applies when LICENSE_MODE=lifetime.');
    }
  }
}
