import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { AUTH_EVENTS } from './auth-events';

interface RefreshRecord {
  tenantId: string;
  userId: string;
  familyId: string;
  used: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

function refreshTtlSeconds(config: ConfigService): number {
  // JWT_REFRESH_EXPIRES_IN is an `ms`-style string (e.g. "7d"); Redis EXPIRE
  // wants whole seconds, so parse the handful of units we actually use
  // rather than pulling in `ms` as a dependency for this alone.
  const raw = config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d';
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(raw.trim());
  if (!match) {
    return 7 * 24 * 60 * 60;
  }
  const value = Number(match[1]);
  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * unitSeconds;
}

/**
 * Access tokens are short-lived, stateless JWTs (`JwtService`, configured
 * in tenancy.module.ts / auth.module.ts) — cheap to verify on every
 * request, deliberately carrying only `{ sub, tenantId }`. Roles and
 * permissions are NOT embedded in the token: `TenantScopeInterceptor` loads
 * them fresh from the DB every request specifically so a permission/role
 * change takes effect immediately, not after the access token's TTL runs
 * out.
 *
 * Refresh tokens are opaque random ids tracked in Redis, one record per
 * token, keyed by `auth:rt:<tokenId>`:
 *   - `used: false` — currently valid; the ONLY state a rotation accepts.
 *   - `used: true`  — already rotated away, but the record is kept until
 *     its original TTL expires as a tombstone. Presenting it again is
 *     reuse (someone has a copy of a token that was already exchanged —
 *     the hallmark of a stolen refresh token), and revokes every token in
 *     its family.
 *   - missing entirely — never issued, or its family/TTL already expired.
 *     Treated as a plain invalid token, not a reuse signal.
 * `auth:family:<familyId>` tracks the set of currently-active (not yet
 * rotated-away) token ids in one login session, so reuse detection and
 * logout-all can revoke a whole family/user in one sweep.
 * `auth:userfamilies:<tenantId>:<userId>` tracks every family a user has
 * live, for logout-all.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  signAccessToken(tenantId: string, userId: string): string {
    return this.jwt.sign({ sub: userId, tenantId });
  }

  /**
   * Step 4.1 — mints a tenant access token for a platform admin
   * IMPERSONATING `userId`, verified by the SAME `TenantScopeInterceptor`
   * path (and the SAME `JWT_SECRET`) as an ordinary login-issued token —
   * see that file's `authenticate()` for how `impersonatedBy`/
   * `impersonationSessionId` are checked against a live `ImpersonationSession`
   * row on every request. Deliberately NO refresh token is issued
   * alongside this one: the token's own `exp` is set to the session's
   * (capped, see PlatformImpersonationService) remaining lifetime, and
   * when it lapses the platform admin must explicitly start a new,
   * separately-audited session rather than silently extending one — a
   * time-boxed session that can be silently refreshed forever isn't
   * actually time-boxed.
   */
  signImpersonationAccessToken(
    tenantId: string,
    userId: string,
    platformAdminId: string,
    impersonationSessionId: string,
    expiresInSeconds: number,
  ): string {
    return this.jwt.sign(
      { sub: userId, tenantId, impersonatedBy: platformAdminId, impersonationSessionId },
      { expiresIn: expiresInSeconds },
    );
  }

  async issueRefreshToken(tenantId: string, userId: string, familyId: string = randomUUID()): Promise<string> {
    const tokenId = randomUUID();
    const ttl = refreshTtlSeconds(this.config);
    const record: RefreshRecord = { tenantId, userId, familyId, used: false };

    await this.redis.set(this.recordKey(tokenId), JSON.stringify(record), 'EX', ttl);
    await this.redis.sadd(this.familyKey(familyId), tokenId);
    await this.redis.expire(this.familyKey(familyId), ttl);
    await this.redis.sadd(this.userFamiliesKey(tenantId, userId), familyId);
    await this.redis.expire(this.userFamiliesKey(tenantId, userId), ttl);

    return tokenId;
  }

  /**
   * Validates + rotates a refresh token: the old one is marked used (not
   * deleted, so reuse can still be detected within its original window)
   * and a new one is issued in the same family. Throws on any invalid
   * token and, on detected reuse, first revokes the entire family before
   * throwing.
   */
  async rotate(tenantId: string, presentedTokenId: string): Promise<{ userId: string } & IssuedTokens> {
    const record = await this.getRecord(presentedTokenId);
    const invalid = () => new UnauthorizedException('Invalid or expired refresh token.');

    if (!record) {
      throw invalid();
    }
    if (record.tenantId !== tenantId) {
      throw invalid();
    }
    if (record.used) {
      await this.revokeFamily(record.tenantId, record.userId, record.familyId);
      this.eventEmitter.emit(AUTH_EVENTS.REFRESH_REUSE_DETECTED, {
        type: AUTH_EVENTS.REFRESH_REUSE_DETECTED,
        tenantId: record.tenantId,
        userId: record.userId,
      });
      throw invalid();
    }

    await this.redis.set(
      this.recordKey(presentedTokenId),
      JSON.stringify({ ...record, used: true }),
      'KEEPTTL',
    );
    await this.redis.srem(this.familyKey(record.familyId), presentedTokenId);

    const refreshToken = await this.issueRefreshToken(record.tenantId, record.userId, record.familyId);
    const accessToken = this.signAccessToken(record.tenantId, record.userId);

    return { userId: record.userId, accessToken, refreshToken };
  }

  /** Revokes exactly the family the presented token belongs to (logout — one session). */
  async revokeToken(tenantId: string, tokenId: string): Promise<void> {
    const record = await this.getRecord(tokenId);
    if (!record || record.tenantId !== tenantId) {
      return;
    }
    await this.revokeFamily(record.tenantId, record.userId, record.familyId);
  }

  /** Revokes every family/session for a user (logout-all). */
  async revokeAllForUser(tenantId: string, userId: string): Promise<void> {
    const familyIds = await this.redis.smembers(this.userFamiliesKey(tenantId, userId));
    await Promise.all(familyIds.map((familyId) => this.revokeFamily(tenantId, userId, familyId)));
    await this.redis.del(this.userFamiliesKey(tenantId, userId));
  }

  private async revokeFamily(tenantId: string, userId: string, familyId: string): Promise<void> {
    const tokenIds = await this.redis.smembers(this.familyKey(familyId));
    if (tokenIds.length > 0) {
      await this.redis.del(...tokenIds.map((id) => this.recordKey(id)));
    }
    await this.redis.del(this.familyKey(familyId));
    await this.redis.srem(this.userFamiliesKey(tenantId, userId), familyId);
  }

  private async getRecord(tokenId: string): Promise<RefreshRecord | null> {
    const raw = await this.redis.get(this.recordKey(tokenId));
    return raw ? (JSON.parse(raw) as RefreshRecord) : null;
  }

  private recordKey(tokenId: string): string {
    return `auth:rt:${tokenId}`;
  }

  private familyKey(familyId: string): string {
    return `auth:family:${familyId}`;
  }

  private userFamiliesKey(tenantId: string, userId: string): string {
    return `auth:userfamilies:${tenantId}:${userId}`;
  }
}
