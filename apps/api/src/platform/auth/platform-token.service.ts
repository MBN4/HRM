import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { PlatformRoleNameKey } from '@hrm/shared';
import { REDIS_CLIENT } from '../../redis/redis.constants';

export interface PlatformAccessTokenPayload {
  sub: string;
  role: PlatformRoleNameKey;
}

interface PlatformRefreshRecord {
  platformAdminId: string;
  familyId: string;
  used: boolean;
}

function refreshTtlSeconds(config: ConfigService): number {
  const raw = config.get<string>('PLATFORM_JWT_REFRESH_EXPIRES_IN') ?? '12h';
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(raw.trim());
  if (!match) {
    return 12 * 60 * 60;
  }
  const value = Number(match[1]);
  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * unitSeconds;
}

/**
 * Platform admin tokens are DELIBERATELY signed with a SEPARATE secret
 * (`PLATFORM_JWT_SECRET`, distinct from tenant auth's `JWT_SECRET`) and a
 * SEPARATE `JwtService` instance from `TokenService`'s — this is a
 * structural guarantee, not just a convention: a tenant user's access
 * token can never verify as a platform token (and vice versa) no matter
 * what claims get crafted into it, because the two token families don't
 * even share a signing key. Same class of "separate signing surface for
 * the most sensitive credential in the system" decision 0.6 makes for
 * license files (RS256, a dedicated keypair) — see
 * docs/conventions/licensing-feature-flags.md.
 *
 * Refresh rotation + reuse detection mirrors `apps/api/src/auth/token.service.ts`
 * exactly (family tracking, a rotated-away token kept as a tombstone,
 * presenting it again revokes the whole family) but keyed by
 * `platformAdminId` alone — there is no tenant dimension for a platform
 * admin's own session. Deliberately a SEPARATE, small implementation
 * rather than a generalized shared base: forcing `TokenService` to accept
 * an optional tenantId would blur a security-relevant type distinction
 * (a platform session token must never be structurally confusable with a
 * tenant one) for a few dozen lines of savings.
 */
@Injectable()
export class PlatformTokenService {
  private readonly jwt: JwtService;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const secret = config.get<string>('PLATFORM_JWT_SECRET');
    if (!secret) {
      throw new Error('PLATFORM_JWT_SECRET is not set.');
    }
    this.jwt = new JwtService({
      secret,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signOptions: { expiresIn: (config.get<string>('PLATFORM_JWT_EXPIRES_IN') ?? '30m') as any },
    });
  }

  signAccessToken(platformAdminId: string, role: PlatformRoleNameKey): string {
    return this.jwt.sign({ sub: platformAdminId, role } satisfies PlatformAccessTokenPayload);
  }

  verifyAccessToken(token: string): PlatformAccessTokenPayload {
    return this.jwt.verify<PlatformAccessTokenPayload>(token);
  }

  async issueRefreshToken(platformAdminId: string, familyId: string = randomUUID()): Promise<string> {
    const tokenId = randomUUID();
    const ttl = refreshTtlSeconds(this.config);
    const record: PlatformRefreshRecord = { platformAdminId, familyId, used: false };

    await this.redis.set(this.recordKey(tokenId), JSON.stringify(record), 'EX', ttl);
    await this.redis.sadd(this.familyKey(familyId), tokenId);
    await this.redis.expire(this.familyKey(familyId), ttl);
    await this.redis.sadd(this.adminFamiliesKey(platformAdminId), familyId);
    await this.redis.expire(this.adminFamiliesKey(platformAdminId), ttl);

    return tokenId;
  }

  /**
   * Validates + rotates a refresh token. Returns only `platformAdminId` —
   * NOT a signed access token — deliberately: the caller (`PlatformAuthService`)
   * re-reads the admin's CURRENT role from the DB before signing a new
   * access token, so a role change (or suspension, checked there too)
   * takes effect on the very next refresh, not just the next full login.
   */
  async rotate(presentedTokenId: string): Promise<{ platformAdminId: string; refreshToken: string }> {
    const record = await this.getRecord(presentedTokenId);
    const invalid = () => new UnauthorizedException('Invalid or expired refresh token.');

    if (!record) {
      throw invalid();
    }
    if (record.used) {
      await this.revokeFamily(record.platformAdminId, record.familyId);
      throw invalid();
    }

    await this.redis.set(this.recordKey(presentedTokenId), JSON.stringify({ ...record, used: true }), 'KEEPTTL');
    await this.redis.srem(this.familyKey(record.familyId), presentedTokenId);

    const refreshToken = await this.issueRefreshToken(record.platformAdminId, record.familyId);
    return { platformAdminId: record.platformAdminId, refreshToken };
  }

  async revokeToken(tokenId: string): Promise<void> {
    const record = await this.getRecord(tokenId);
    if (!record) {
      return;
    }
    await this.revokeFamily(record.platformAdminId, record.familyId);
  }

  async revokeAllForAdmin(platformAdminId: string): Promise<void> {
    const familyIds = await this.redis.smembers(this.adminFamiliesKey(platformAdminId));
    await Promise.all(familyIds.map((familyId) => this.revokeFamily(platformAdminId, familyId)));
    await this.redis.del(this.adminFamiliesKey(platformAdminId));
  }

  private async revokeFamily(platformAdminId: string, familyId: string): Promise<void> {
    const tokenIds = await this.redis.smembers(this.familyKey(familyId));
    if (tokenIds.length > 0) {
      await this.redis.del(...tokenIds.map((id) => this.recordKey(id)));
    }
    await this.redis.del(this.familyKey(familyId));
    await this.redis.srem(this.adminFamiliesKey(platformAdminId), familyId);
  }

  private async getRecord(tokenId: string): Promise<PlatformRefreshRecord | null> {
    const raw = await this.redis.get(this.recordKey(tokenId));
    return raw ? (JSON.parse(raw) as PlatformRefreshRecord) : null;
  }

  private recordKey(tokenId: string): string {
    return `platform:auth:rt:${tokenId}`;
  }

  private familyKey(familyId: string): string {
    return `platform:auth:family:${familyId}`;
  }

  private adminFamiliesKey(platformAdminId: string): string {
    return `platform:auth:adminfamilies:${platformAdminId}`;
  }
}
