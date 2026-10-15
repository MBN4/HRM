import { Injectable } from '@nestjs/common';
import { prisma } from '@hrm/db';
import { HashingService } from '../../common/hashing/hashing.service';
import { KIOSK_TOKEN_PREFIX_LENGTH } from './kiosk.constants';

export interface ValidatedKiosk {
  kioskId: string;
  tenantId: string;
  branchId: string;
  name: string;
  requirePhoto: boolean;
  biometricEnabled: boolean;
}

/** `lastSeenAt` is a heartbeat, not an audit field — writing it on every request would turn each punch into two writes. */
const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * The THIRD, parallel authentication path (after JWT and 3.3's API key): a registered kiosk device
 * presents `X-Kiosk-Token`. Same shape as `ApiKeyAuthService` — an indexed plaintext prefix finds the
 * row, an argon2id hash decides — and, like it, the token itself ESTABLISHES the tenant, so the lookup
 * runs on the OWNER `prisma` client (no tenant context exists yet; the same narrow, documented exception).
 * Every other query in the request then runs through RLS-scoped `appPrisma` inside `withTenantContext`.
 *
 * A REVOKED kiosk is never returned (status filter in the query), so revocation takes effect on the very
 * next request — there is no token cache to go stale.
 */
@Injectable()
export class KioskAuthService {
  constructor(private readonly hashing: HashingService) {}

  async validate(rawToken: string): Promise<ValidatedKiosk | null> {
    if (!rawToken || rawToken.length < KIOSK_TOKEN_PREFIX_LENGTH) {
      return null;
    }
    const kiosk = await prisma.kiosk.findUnique({
      where: { tokenPrefix: rawToken.slice(0, KIOSK_TOKEN_PREFIX_LENGTH) },
    });
    if (!kiosk || kiosk.status !== 'ACTIVE') {
      return null;
    }
    if (!(await this.hashing.verify(kiosk.hashedToken, rawToken))) {
      return null;
    }

    const now = new Date();
    if (!kiosk.lastSeenAt || now.getTime() - kiosk.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await prisma.kiosk
        .update({ where: { id: kiosk.id }, data: { lastSeenAt: now } })
        .catch(() => undefined);
    }
    return {
      kioskId: kiosk.id,
      tenantId: kiosk.tenantId,
      branchId: kiosk.branchId,
      name: kiosk.name,
      requirePhoto: kiosk.requirePhoto,
      biometricEnabled: kiosk.biometricEnabled,
    };
  }
}
