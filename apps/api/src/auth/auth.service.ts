import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import type { Redis } from 'ioredis';
import type {
  ChangePasswordInput,
  LoginInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
} from '@hrm/shared';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { AUTH_EVENTS } from './auth-events';
import { PermissionsCacheService } from './permissions-cache.service';
import { PasswordService } from './password.service';
import { AUTH_PROVIDER } from './providers/auth-provider.token';
import type { AuthProvider } from './providers/auth-provider.interface';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { TokenService } from './token.service';

const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  roles: string[];
  permissions: string[];
  branchIds: string[] | null;
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
  ) {}

  async login(tenantId: string, tx: Prisma.TransactionClient, input: LoginInput): Promise<AuthenticatedSession> {
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
    // user can log in.
    await this.rateLimiter.reset(rateLimitKey);

    const { roles, permissions, branchIds } = await this.permissionsCache.getContext(tx, tenantId, user.id);
    const accessToken = this.tokens.signAccessToken(tenantId, user.id);
    const refreshToken = await this.tokens.issueRefreshToken(tenantId, user.id);

    this.emit(AUTH_EVENTS.LOGIN, tenantId, { userId: user.id });

    return { accessToken, refreshToken, userId: user.id, roles, permissions, branchIds };
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

  private resetKey(token: string): string {
    return `auth:pwreset:${token}`;
  }

  private emit(type: (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS], tenantId: string, extra: Record<string, string>) {
    this.eventEmitter.emit(type, { type, tenantId, ...extra });
  }
}
