import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Prisma, SsoConfig } from '@hrm/db';
import type { Redis } from 'ioredis';
import type { SsoConfigInput } from '@hrm/shared';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { HashingService } from '../../common/hashing/hashing.service';
import type { AuthenticatedSession } from '../auth.service';
import { loadUserContext } from '../load-user-context.util';
import { TokenService } from '../token.service';
import { OIDC_AUTH_PROVIDER, SAML_AUTH_PROVIDER } from './sso-auth-provider.interface';
import type { SsoAuthProvider } from './sso-auth-provider.interface';

const STATE_TTL_SECONDS = 5 * 60;

/**
 * Orchestrates the SSO seam finished in this step — see
 * `sso-auth-provider.interface.ts` for why this is a SEPARATE flow from
 * `AuthService.login`, not a second `AUTH_PROVIDER` binding. Owns:
 * config CRUD (secret encryption on write, redaction on read), the
 * redirect-out/state-tracking/redirect-back dance (Redis, same "opaque,
 * short-lived, per-flow token" shape `TokenService`/`RateLimiterService`
 * already use), find-or-provision a real `User`, and issuing the SAME
 * tokens `AuthService.login` issues so a client's session is
 * indistinguishable either way.
 */
@Injectable()
export class SsoService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly hashing: HashingService,
    private readonly tokens: TokenService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(OIDC_AUTH_PROVIDER) private readonly oidcProvider: SsoAuthProvider,
    @Inject(SAML_AUTH_PROVIDER) private readonly samlProvider: SsoAuthProvider,
  ) {}

  async getConfig(tx: Prisma.TransactionClient, tenantId: string): Promise<SsoConfig | null> {
    return tx.ssoConfig.findUnique({ where: { tenantId } });
  }

  /** Redacts the secret before this ever reaches an HTTP response — read-back never returns the plaintext/decrypted client secret. */
  redactConfig(config: Prisma.JsonValue): Record<string, unknown> {
    const clone = { ...(config as Record<string, unknown>) };
    if ('clientSecret' in clone) {
      clone.clientSecret = '[REDACTED]';
    }
    return clone;
  }

  async upsertConfig(tx: Prisma.TransactionClient, tenantId: string, input: SsoConfigInput): Promise<SsoConfig> {
    const toStore: SsoConfigInput =
      input.protocol === 'OIDC' ? { ...input, clientSecret: this.encryption.encrypt(input.clientSecret) } : input;

    return tx.ssoConfig.upsert({
      where: { tenantId },
      create: { tenantId, protocol: input.protocol, enabled: false, config: toStore },
      update: { protocol: input.protocol, config: toStore },
    });
  }

  async setEnabled(tx: Prisma.TransactionClient, tenantId: string, enabled: boolean): Promise<SsoConfig> {
    const existing = await this.getConfig(tx, tenantId);
    if (!existing) {
      throw new NotFoundException('No SSO configuration exists for this tenant yet — configure one first.');
    }
    return tx.ssoConfig.update({ where: { tenantId }, data: { enabled } });
  }

  async beginLogin(tx: Prisma.TransactionClient, tenantId: string, callbackUrl: string): Promise<{ redirectUrl: string }> {
    const row = await this.requireEnabledConfig(tx, tenantId);
    const decrypted = this.decryptConfig(row.config as unknown as SsoConfigInput);

    const state = randomUUID();
    await this.redis.set(this.stateKey(state), tenantId, 'EX', STATE_TTL_SECONDS);

    const redirectUrl = await this.providerFor(row.protocol).buildAuthorizationUrl(decrypted, callbackUrl, state);
    return { redirectUrl };
  }

  async handleCallback(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callbackUrl: string,
    params: Record<string, string>,
  ): Promise<AuthenticatedSession> {
    const state = params.state ?? params.RelayState;
    if (!state) {
      throw new UnauthorizedException('Missing SSO state parameter.');
    }
    const stateTenantId = await this.redis.get(this.stateKey(state));
    if (!stateTenantId || stateTenantId !== tenantId) {
      throw new UnauthorizedException('Invalid or expired SSO state — the login flow must be restarted.');
    }
    await this.redis.del(this.stateKey(state));

    const row = await this.requireEnabledConfig(tx, tenantId);
    const decrypted = this.decryptConfig(row.config as unknown as SsoConfigInput);
    const identity = await this.providerFor(row.protocol).handleCallback(decrypted, callbackUrl, params);
    this.assertAllowedDomain(decrypted, identity.email);

    const user = await this.findOrProvisionUser(tx, tenantId, decrypted, identity.email);
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is not active.');
    }

    const { roles, permissions, branchIds } = await loadUserContext(tx, user.id);
    const accessToken = this.tokens.signAccessToken(tenantId, user.id);
    const refreshToken = await this.tokens.issueRefreshToken(tenantId, user.id);
    return { accessToken, refreshToken, userId: user.id, roles, permissions, branchIds };
  }

  private async requireEnabledConfig(tx: Prisma.TransactionClient, tenantId: string): Promise<SsoConfig> {
    const row = await this.getConfig(tx, tenantId);
    if (!row || !row.enabled) {
      throw new NotFoundException('SSO is not configured/enabled for this tenant.');
    }
    return row;
  }

  private async findOrProvisionUser(
    tx: Prisma.TransactionClient,
    tenantId: string,
    config: SsoConfigInput,
    email: string,
  ) {
    const existing = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
    if (existing) {
      return existing;
    }

    const role = await tx.role.findUnique({ where: { tenantId_name: { tenantId, name: config.defaultRoleName } } });
    if (!role) {
      throw new UnauthorizedException(`The configured default SSO role "${config.defaultRoleName}" does not exist for this tenant.`);
    }

    // SSO-provisioned users never log in with a password — a random,
    // never-communicated hash (never reversible, via the same argon2id
    // HashingService API keys/device secrets use) makes the password-login
    // path structurally unusable for this account rather than merely
    // "unknown to the user".
    const unusablePasswordHash = await this.hashing.hash(`${randomUUID()}${randomUUID()}`);
    const user = await tx.user.create({ data: { tenantId, email, hashedPassword: unusablePasswordHash, status: 'ACTIVE' } });
    await tx.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    return user;
  }

  private assertAllowedDomain(config: SsoConfigInput, email: string): void {
    if (!config.allowedEmailDomains || config.allowedEmailDomains.length === 0) {
      return;
    }
    const domain = email.split('@')[1]?.toLowerCase();
    const allowed = config.allowedEmailDomains.map((d) => d.toLowerCase());
    if (!domain || !allowed.includes(domain)) {
      throw new UnauthorizedException('This email domain is not permitted to use SSO for this tenant.');
    }
  }

  private decryptConfig(config: SsoConfigInput): SsoConfigInput {
    return config.protocol === 'OIDC' ? { ...config, clientSecret: this.encryption.decrypt(config.clientSecret) } : config;
  }

  private providerFor(protocol: SsoConfig['protocol']): SsoAuthProvider {
    return protocol === 'OIDC' ? this.oidcProvider : this.samlProvider;
  }

  private stateKey(state: string): string {
    return `sso:state:${state}`;
  }
}
