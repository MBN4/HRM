import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@hrm/db';
import type { Redis } from 'ioredis';
import type {
  ChangePasswordInput,
  LoginInput,
  MfaDisableInput,
  MfaEnrollConfirmInput,
  MfaVerifyInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
} from '@hrm/shared';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { AUTH_EVENTS } from './auth-events';
import { TenantMfaService } from './mfa/tenant-mfa.service';
import { PermissionsCacheService } from './permissions-cache.service';
import { PasswordService } from './password.service';
import { AUTH_PROVIDER } from './providers/auth-provider.token';
import type { AuthProvider } from './providers/auth-provider.interface';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { TokenService } from './token.service';

const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
const MFA_ENROLLMENT_TTL_SECONDS = 10 * 60;
const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  roles: string[];
  permissions: string[];
  branchIds: string[] | null;
}

/** Returned by `login()` in place of a session when the account has MFA enabled — a client must call `POST /auth/mfa/verify` with this token next. */
export interface MfaChallengeResult {
  mfaRequired: true;
  challengeToken: string;
}

interface MfaEnrollRecord {
  userId: string;
  encryptedSecret: string;
}

interface MfaChallengeRecord {
  userId: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly rateLimiter: RateLimiterService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly permissionsCache: PermissionsCacheService,
    private readonly mfa: TenantMfaService,
  ) {}

  async login(tenantId: string, tx: Prisma.TransactionClient, input: LoginInput): Promise<AuthenticatedSession | MfaChallengeResult> {
    const rateLimitKey = `login:${tenantId}:${input.email}`;
    await this.rateLimiter.consume(rateLimitKey, 5, 15 * 60);

    const user = await this.authProvider.validate(tx, tenantId, input.email, input.password);
    if (!user || user.status !== 'ACTIVE') {
      this.emit(AUTH_EVENTS.LOGIN_FAILED, tenantId, { email: input.email });
      // Same message whether the email doesn't exist, the password is
      // wrong, or the account is inactive — no user enumeration.
      throw new UnauthorizedException('Invalid email or password.');
    }

    // Reset on success: the window exists to punish a run of failures
    // (credential stuffing/guessing), not to cap how often a legitimate
    // user can log in. Reset happens once the PASSWORD factor succeeds,
    // regardless of whether an MFA step follows — a correct password is
    // still evidence this isn't a guessing attack.
    await this.rateLimiter.reset(rateLimitKey);

    if (user.mfaEnabled) {
      const challengeToken = randomUUID();
      await this.redis.set(
        this.mfaChallengeKey(tenantId, challengeToken),
        JSON.stringify({ userId: user.id } satisfies MfaChallengeRecord),
        'EX',
        MFA_CHALLENGE_TTL_SECONDS,
      );
      this.emit(AUTH_EVENTS.MFA_CHALLENGE_ISSUED, tenantId, { userId: user.id });
      return { mfaRequired: true, challengeToken };
    }

    const session = await this.issueSession(tenantId, tx, user.id);
    this.emit(AUTH_EVENTS.LOGIN, tenantId, { userId: user.id });
    return session;
  }

  /**
   * Completes an MFA-required login: validates the challenge token (issued
   * by `login()` above) and either a TOTP code or a one-time recovery code,
   * the same acceptance shape `PlatformAuthService.verifyMfa` already
   * established. Rate-limited per user, separately from the password step,
   * so a stolen/guessed password alone still can't be brute-forced into a
   * session.
   */
  async verifyMfa(tenantId: string, tx: Prisma.TransactionClient, input: MfaVerifyInput): Promise<AuthenticatedSession> {
    const record = await this.getRecord<MfaChallengeRecord>(this.mfaChallengeKey(tenantId, input.challengeToken));
    const invalid = () => new UnauthorizedException('Invalid or expired MFA challenge — log in again.');
    if (!record) {
      throw invalid();
    }

    const user = await tx.user.findUnique({ where: { id: record.userId } });
    if (!user || user.status !== 'ACTIVE' || !user.mfaEnabled || !user.mfaSecretEncrypted) {
      throw invalid();
    }

    await this.rateLimiter.consume(`mfa:${tenantId}:${user.id}`, 8, 15 * 60);

    let ok = /^\d{6}$/.test(input.code) && this.mfa.verifyCode(user.mfaSecretEncrypted, input.code);
    if (!ok) {
      const hashedCodes = ((user.mfaRecoveryCodesHashed as string[] | null) ?? []) as string[];
      const remaining = await this.mfa.verifyAndConsumeRecoveryCode(hashedCodes, input.code);
      if (remaining) {
        ok = true;
        await tx.user.update({ where: { id: user.id }, data: { mfaRecoveryCodesHashed: remaining } });
        this.emit(AUTH_EVENTS.MFA_RECOVERY_CODE_USED, tenantId, { userId: user.id });
      }
    }

    if (!ok) {
      this.emit(AUTH_EVENTS.MFA_VERIFY_FAILED, tenantId, { userId: user.id });
      throw new UnauthorizedException('Invalid MFA code.');
    }

    await this.rateLimiter.reset(`mfa:${tenantId}:${user.id}`);
    await this.redis.del(this.mfaChallengeKey(tenantId, input.challengeToken));

    const session = await this.issueSession(tenantId, tx, user.id);
    this.emit(AUTH_EVENTS.LOGIN, tenantId, { userId: user.id });
    return session;
  }

  /** Starts (or restarts) enrollment for the CALLER's own account — already authenticated, so no separate token is needed the way platform's pre-session enrollment flow needs one. */
  async startMfaEnrollment(tenantId: string, tx: Prisma.TransactionClient, userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const enrollment = this.mfa.generateEnrollment(user.email);
    await this.redis.set(
      this.mfaEnrollKey(tenantId, userId),
      JSON.stringify({ userId, encryptedSecret: enrollment.encryptedSecret } satisfies MfaEnrollRecord),
      'EX',
      MFA_ENROLLMENT_TTL_SECONDS,
    );
    return { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl };
  }

  async confirmMfaEnrollment(
    tenantId: string,
    tx: Prisma.TransactionClient,
    userId: string,
    input: MfaEnrollConfirmInput,
  ): Promise<{ recoveryCodes: string[] }> {
    const record = await this.getRecord<MfaEnrollRecord>(this.mfaEnrollKey(tenantId, userId));
    if (!record) {
      throw new UnauthorizedException('No pending MFA enrollment — call POST /auth/mfa/enroll first.');
    }
    if (!this.mfa.verifyCode(record.encryptedSecret, input.code)) {
      this.emit(AUTH_EVENTS.MFA_ENROLL_FAILED, tenantId, { userId });
      throw new UnauthorizedException('Invalid verification code.');
    }

    const recoveryCodes = this.mfa.generateRecoveryCodes();
    const hashedRecoveryCodes = await this.mfa.hashRecoveryCodes(recoveryCodes);
    await tx.user.update({
      where: { id: userId },
      data: { mfaSecretEncrypted: record.encryptedSecret, mfaEnabled: true, mfaRecoveryCodesHashed: hashedRecoveryCodes },
    });
    await this.redis.del(this.mfaEnrollKey(tenantId, userId));
    this.emit(AUTH_EVENTS.MFA_ENROLLED, tenantId, { userId });

    return { recoveryCodes };
  }

  /** Requires BOTH the current password AND a valid MFA code — a hijacked session (valid access token, no password) alone cannot silently turn MFA off. */
  async disableMfa(tenantId: string, tx: Prisma.TransactionClient, userId: string, input: MfaDisableInput): Promise<void> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const invalid = () => new UnauthorizedException('Current password or MFA code is incorrect.');

    if (!(await this.password.verify(user.hashedPassword, input.password))) {
      throw invalid();
    }
    if (!user.mfaEnabled || !user.mfaSecretEncrypted) {
      throw invalid();
    }

    let ok = /^\d{6}$/.test(input.code) && this.mfa.verifyCode(user.mfaSecretEncrypted, input.code);
    if (!ok) {
      const hashedCodes = ((user.mfaRecoveryCodesHashed as string[] | null) ?? []) as string[];
      ok = (await this.mfa.verifyAndConsumeRecoveryCode(hashedCodes, input.code)) !== null;
    }
    if (!ok) {
      throw invalid();
    }

    await tx.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaRecoveryCodesHashed: Prisma.JsonNull },
    });
    // Disabling a second factor is exactly the kind of change that should
    // invalidate every other live session — same posture changePassword
    // already takes below.
    await this.tokens.revokeAllForUser(tenantId, userId);
    this.emit(AUTH_EVENTS.MFA_DISABLED, tenantId, { userId });
  }

  async refresh(tenantId: string, refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    await this.rateLimiter.consume(`refresh:${tenantId}:${refreshToken}`, 10, 60);
    const { accessToken, refreshToken: newRefreshToken } = await this.tokens.rotate(tenantId, refreshToken);
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(tenantId: string, userId: string, refreshToken: string): Promise<void> {
    await this.tokens.revokeToken(tenantId, refreshToken);
    this.emit(AUTH_EVENTS.LOGOUT, tenantId, { userId });
  }

  async logoutAll(tenantId: string, userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(tenantId, userId);
    this.emit(AUTH_EVENTS.LOGOUT_ALL, tenantId, { userId });
  }

  async changePassword(
    tenantId: string,
    tx: Prisma.TransactionClient,
    userId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    const valid = await this.password.verify(user.hashedPassword, input.currentPassword);
    if (!valid) {
      // The caller is already authenticated as this account, so naming the
      // failure precisely isn't an enumeration risk the way login is.
      throw new UnauthorizedException('Current password is incorrect.');
    }

    const hashedPassword = await this.password.hash(input.newPassword);
    await tx.user.update({ where: { id: userId }, data: { hashedPassword } });
    await this.tokens.revokeAllForUser(tenantId, userId);

    this.emit(AUTH_EVENTS.PASSWORD_CHANGED, tenantId, { userId });
  }

  async requestPasswordReset(
    tenantId: string,
    tx: Prisma.TransactionClient,
    input: RequestPasswordResetInput,
  ): Promise<void> {
    await this.rateLimiter.consume(`reset:${tenantId}:${input.email}`, 5, 15 * 60);

    const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email: input.email } } });
    // Always behave the same whether the account exists or not — no
    // enumeration via response timing/shape. The token is only ever
    // created (and logged/emitted) when there's a real account.
    if (user) {
      const token = randomUUID();
      await this.redis.set(
        this.resetKey(token),
        JSON.stringify({ tenantId, userId: user.id }),
        'EX',
        PASSWORD_RESET_TTL_SECONDS,
      );

      // `token` reaches the notification hub (0.8) through this same
      // event — NotificationDispatchListener maps PASSWORD_RESET_REQUESTED
      // to an EMAIL+IN_APP notification whose template renders it. See
      // auth-events.ts's doc comment on `token` for why this field is
      // sensitive and must never be persisted unredacted by 0.9.
      this.emit(AUTH_EVENTS.PASSWORD_RESET_REQUESTED, tenantId, { userId: user.id, email: input.email, token });
    }
  }

  async resetPassword(tenantId: string, tx: Prisma.TransactionClient, input: ResetPasswordInput): Promise<void> {
    const raw = await this.redis.get(this.resetKey(input.token));
    const invalid = () => new UnauthorizedException('Invalid or expired reset token.');
    if (!raw) {
      throw invalid();
    }

    const record = JSON.parse(raw) as { tenantId: string; userId: string };
    if (record.tenantId !== tenantId) {
      throw invalid();
    }

    await this.redis.del(this.resetKey(input.token));

    const hashedPassword = await this.password.hash(input.newPassword);
    await tx.user.update({ where: { id: record.userId }, data: { hashedPassword } });
    await this.tokens.revokeAllForUser(tenantId, record.userId);

    this.emit(AUTH_EVENTS.PASSWORD_RESET_COMPLETED, tenantId, { userId: record.userId });
  }

  private async issueSession(tenantId: string, tx: Prisma.TransactionClient, userId: string): Promise<AuthenticatedSession> {
    const { roles, permissions, branchIds } = await this.permissionsCache.getContext(tx, tenantId, userId);
    const accessToken = this.tokens.signAccessToken(tenantId, userId);
    const refreshToken = await this.tokens.issueRefreshToken(tenantId, userId);
    return { accessToken, refreshToken, userId, roles, permissions, branchIds };
  }

  private async getRecord<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private resetKey(token: string): string {
    return `auth:pwreset:${token}`;
  }

  private mfaEnrollKey(tenantId: string, userId: string): string {
    return `auth:mfa:enroll:${tenantId}:${userId}`;
  }

  private mfaChallengeKey(tenantId: string, token: string): string {
    return `auth:mfa:challenge:${tenantId}:${token}`;
  }

  private emit(type: (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS], tenantId: string, extra: Record<string, string>) {
    this.eventEmitter.emit(type, { type, tenantId, ...extra });
  }
}
