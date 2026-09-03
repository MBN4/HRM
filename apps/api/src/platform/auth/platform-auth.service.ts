import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { prisma } from '@hrm/db';
import type {
  PlatformLoginInput,
  PlatformMfaEnrollConfirmInput,
  PlatformMfaVerifyInput,
  PlatformRoleNameKey,
} from '@hrm/shared';
import { PasswordService } from '../../auth/password.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { RateLimiterService } from '../../redis/rate-limiter.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';
import { PlatformMfaService } from './platform-mfa.service';
import { PlatformTokenService } from './platform-token.service';

export interface PlatformLoginStepResult {
  mfaSetupRequired?: true;
  enrollmentToken?: string;
  mfaRequired?: true;
  challengeToken?: string;
}

export interface PlatformAuthSession {
  accessToken: string;
  refreshToken: string;
  platformAdminId: string;
  role: PlatformRoleNameKey;
  name: string;
  email: string;
}

interface EnrollRecord {
  platformAdminId: string;
  encryptedSecret?: string;
}

interface ChallengeRecord {
  platformAdminId: string;
}

const ENROLLMENT_TTL_SECONDS = 10 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Orchestrates the platform login state machine — see
 * docs/conventions/vendor-console.md → Mandatory MFA for the full flow.
 * Two factors, always: password (this service, step 1) THEN either a TOTP
 * code (an already-enrolled admin) or completing enrollment (a first-time
 * admin) — there is no code path that issues a session token from a
 * password alone. Every step, success or failure, is recorded to
 * `PlatformAuditRecordService` — this is the single most audited flow in
 * the system, by design.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly password: PasswordService,
    private readonly mfa: PlatformMfaService,
    private readonly tokens: PlatformTokenService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: PlatformAuditRecordService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async login(input: PlatformLoginInput): Promise<PlatformLoginStepResult> {
    await this.rateLimiter.consume(`platform-login:${input.email}`, 5, 15 * 60);
    const genericFail = () => new UnauthorizedException('Invalid email or password.');

    const admin = await prisma.platformAdmin.findUnique({ where: { email: input.email } });
    if (!admin || admin.status !== 'ACTIVE') {
      await this.audit.record({
        platformAdminId: admin?.id ?? null,
        action: 'platform.auth.login_failed',
        entityType: 'PlatformAdmin',
        entityId: admin?.id ?? null,
        metadata: { email: input.email },
      });
      throw genericFail();
    }

    const valid = await this.password.verify(admin.hashedPassword, input.password);
    if (!valid) {
      await this.audit.record({
        platformAdminId: admin.id,
        action: 'platform.auth.login_failed',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
      });
      throw genericFail();
    }

    // Reset on success — same "the window punishes a run of failures, not
    // a legitimate rapid follow-up" posture 0.4's tenant login already
    // takes (see docs/conventions/auth-rbac.md).
    await this.rateLimiter.reset(`platform-login:${input.email}`);

    if (!admin.mfaEnabled) {
      const enrollmentToken = randomUUID();
      await this.redis.set(
        this.enrollKey(enrollmentToken),
        JSON.stringify({ platformAdminId: admin.id } satisfies EnrollRecord),
        'EX',
        ENROLLMENT_TTL_SECONDS,
      );
      await this.audit.record({
        platformAdminId: admin.id,
        action: 'platform.auth.password_verified_mfa_setup_required',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
      });
      return { mfaSetupRequired: true, enrollmentToken };
    }

    const challengeToken = randomUUID();
    await this.redis.set(
      this.challengeKey(challengeToken),
      JSON.stringify({ platformAdminId: admin.id } satisfies ChallengeRecord),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    await this.audit.record({
      platformAdminId: admin.id,
      action: 'platform.auth.password_verified',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
    });
    return { mfaRequired: true, challengeToken };
  }

  async startEnrollment(enrollmentToken: string): Promise<{ secret: string; otpauthUrl: string }> {
    const record = await this.getRecord<EnrollRecord>(this.enrollKey(enrollmentToken));
    if (!record) {
      throw new UnauthorizedException('Invalid or expired enrollment session — log in again.');
    }
    const admin = await this.requireActiveAdmin(record.platformAdminId);
    if (admin.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled for this account.');
    }

    const enrollment = this.mfa.generateEnrollment(admin.email);
    await this.redis.set(
      this.enrollKey(enrollmentToken),
      JSON.stringify({ platformAdminId: admin.id, encryptedSecret: enrollment.encryptedSecret } satisfies EnrollRecord),
      'KEEPTTL',
    );
    return { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl };
  }

  async confirmEnrollment(input: PlatformMfaEnrollConfirmInput): Promise<PlatformAuthSession & { recoveryCodes: string[] }> {
    const record = await this.getRecord<EnrollRecord>(this.enrollKey(input.enrollmentToken));
    if (!record?.encryptedSecret) {
      throw new UnauthorizedException('Invalid or expired enrollment session — call /platform/auth/mfa/enroll first.');
    }
    const admin = await this.requireActiveAdmin(record.platformAdminId);

    if (!this.mfa.verifyCode(record.encryptedSecret, input.code)) {
      await this.audit.record({
        platformAdminId: admin.id,
        action: 'platform.auth.mfa_enroll_failed',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
      });
      throw new UnauthorizedException('Invalid verification code.');
    }

    const recoveryCodes = this.mfa.generateRecoveryCodes();
    const hashedRecoveryCodes = await this.mfa.hashRecoveryCodes(recoveryCodes);
    await prisma.platformAdmin.update({
      where: { id: admin.id },
      data: {
        mfaSecretEncrypted: record.encryptedSecret,
        mfaEnabled: true,
        mfaRecoveryCodesHashed: hashedRecoveryCodes,
        lastLoginAt: new Date(),
      },
    });
    await this.redis.del(this.enrollKey(input.enrollmentToken));
    await this.audit.record({
      platformAdminId: admin.id,
      action: 'platform.auth.mfa_enrolled',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
    });

    const session = await this.issueSession(admin.id, admin.role);
    return { ...session, recoveryCodes };
  }

  async verifyMfa(input: PlatformMfaVerifyInput): Promise<PlatformAuthSession> {
    const record = await this.getRecord<ChallengeRecord>(this.challengeKey(input.challengeToken));
    if (!record) {
      throw new UnauthorizedException('Invalid or expired MFA challenge — log in again.');
    }
    const admin = await this.requireActiveAdmin(record.platformAdminId);
    await this.rateLimiter.consume(`platform-mfa:${admin.id}`, 8, 15 * 60);

    let ok = false;
    if (admin.mfaSecretEncrypted && /^\d{6}$/.test(input.code)) {
      ok = this.mfa.verifyCode(admin.mfaSecretEncrypted, input.code);
    }
    if (!ok) {
      const hashedCodes = ((admin.mfaRecoveryCodesHashed as string[] | null) ?? []) as string[];
      const remaining = await this.mfa.verifyAndConsumeRecoveryCode(hashedCodes, input.code);
      if (remaining) {
        ok = true;
        await prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaRecoveryCodesHashed: remaining } });
        await this.audit.record({
          platformAdminId: admin.id,
          action: 'platform.auth.mfa_recovery_code_used',
          entityType: 'PlatformAdmin',
          entityId: admin.id,
          metadata: { remainingCodes: remaining.length },
        });
      }
    }

    if (!ok) {
      await this.audit.record({
        platformAdminId: admin.id,
        action: 'platform.auth.mfa_verify_failed',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
      });
      throw new UnauthorizedException('Invalid MFA code.');
    }

    await this.rateLimiter.reset(`platform-mfa:${admin.id}`);
    await this.redis.del(this.challengeKey(input.challengeToken));
    await prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      platformAdminId: admin.id,
      action: 'platform.auth.login',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
    });

    return this.issueSession(admin.id, admin.role);
  }

  async refresh(refreshToken: string): Promise<PlatformAuthSession> {
    const rotated = await this.tokens.rotate(refreshToken);
    const admin = await prisma.platformAdmin.findUnique({ where: { id: rotated.platformAdminId } });
    if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled) {
      throw new UnauthorizedException('Platform session is no longer valid.');
    }
    return {
      accessToken: this.tokens.signAccessToken(admin.id, admin.role),
      refreshToken: rotated.refreshToken,
      platformAdminId: admin.id,
      role: admin.role,
      name: admin.name,
      email: admin.email,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeToken(refreshToken);
  }

  async logoutAll(platformAdminId: string): Promise<void> {
    await this.tokens.revokeAllForAdmin(platformAdminId);
    await this.audit.record({
      platformAdminId,
      action: 'platform.auth.logout_all',
      entityType: 'PlatformAdmin',
      entityId: platformAdminId,
    });
  }

  private async issueSession(platformAdminId: string, role: PlatformRoleNameKey): Promise<PlatformAuthSession> {
    const admin = await prisma.platformAdmin.findUniqueOrThrow({ where: { id: platformAdminId } });
    const accessToken = this.tokens.signAccessToken(platformAdminId, role);
    const refreshToken = await this.tokens.issueRefreshToken(platformAdminId);
    return { accessToken, refreshToken, platformAdminId, role, name: admin.name, email: admin.email };
  }

  private async requireActiveAdmin(id: string) {
    const admin = await prisma.platformAdmin.findUnique({ where: { id } });
    if (!admin || admin.status !== 'ACTIVE') {
      throw new UnauthorizedException();
    }
    return admin;
  }

  private async getRecord<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private enrollKey(token: string): string {
    return `platform:auth:enroll:${token}`;
  }

  private challengeKey(token: string): string {
    return `platform:auth:mfa-challenge:${token}`;
  }
}
