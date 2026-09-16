import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { appPrisma } from '@hrm/db';
import { REDIS_CLIENT } from '../redis/redis.constants';

const VERIFIED_DOMAIN_CACHE_PREFIX = 'cors:verified-domain:';
// Same bounded-staleness tradeoff `TenantRateLimitService` already
// documents for itself: a newly-verified custom domain being briefly
// unable to make cross-origin calls for up to this long is not a security
// issue (the domain's own tenant resolution — 0.3/4.3 — is unaffected,
// this cache ONLY gates the CORS allow-list, and worst case a fresh
// browser tab just retries after the TTL) — not worth a Postgres round
// trip on every single cross-origin request.
const VERIFIED_DOMAIN_CACHE_TTL_SECONDS = 30;

/**
 * `main.ts`'s `app.enableCors()` previously ran with NO options at all —
 * any origin, wide open, which is unsafe once `credentials: true` is what
 * a real browser-based login flow needs (portal/admin/mobile all send the
 * access token via `Authorization` header, not a cookie, but preflight
 * `Access-Control-Allow-Origin: *` combined with any future cookie-based
 * flow would be a real CSRF-adjacent gap — see docs/conventions/security-hardening.md).
 *
 * The allow-list mirrors `TenantResolutionService`'s own strategies (step
 * 0.3/4.3), on purpose — an origin should be allowed to call this API
 * exactly when a browser tab pointed at that origin could ALSO resolve a
 * tenant here:
 *   - the bare `TENANT_BASE_DOMAIN` and any of its subdomains
 *     (`https://acme.<base>`), the same suffix match
 *     `TenantResolutionService.resolveBySubdomain` uses;
 *   - any tenant's VERIFIED custom domain (step 4.3) — same
 *     `verificationStatus === 'VERIFIED'` gate `resolveByCustomDomain`
 *     enforces, so an unverified/pending domain can't grant itself CORS
 *     access any more than it can hijack tenant-resolution traffic;
 *   - an explicit `CORS_ADDITIONAL_ORIGINS` allow-list (comma-separated
 *     full origins, e.g. local dev ports for apps/portal|admin|mobile, or
 *     a deployment's own first-party web origins that don't live under
 *     `TENANT_BASE_DOMAIN`).
 * Queries `appPrisma` directly (no tenant context) — `tenant_domains` is
 * RLS-exempt, same reasoning `TenantResolutionService` documents for
 * itself.
 */
@Injectable()
export class CorsOriginService {
  private readonly logger = new Logger(CorsOriginService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async isAllowed(origin: string | undefined): Promise<boolean> {
    // No Origin header at all — a same-origin request, a server-to-server
    // call, or a non-browser client (curl, the mobile app's native HTTP
    // stack). There is nothing to reflect an `Access-Control-Allow-Origin`
    // for, and CORS is a browser-enforced concept only — this is not a
    // bypass of anything.
    if (!origin) {
      return true;
    }

    let hostname: string;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }

    const baseDomain = this.config.get<string>('TENANT_BASE_DOMAIN');
    if (baseDomain && (hostname === baseDomain.toLowerCase() || hostname.endsWith(`.${baseDomain.toLowerCase()}`))) {
      return true;
    }

    if (this.explicitAllowList().includes(origin)) {
      return true;
    }

    return this.isVerifiedTenantDomain(hostname);
  }

  private explicitAllowList(): string[] {
    const raw = this.config.get<string>('CORS_ADDITIONAL_ORIGINS');
    if (!raw) {
      return [];
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async isVerifiedTenantDomain(hostname: string): Promise<boolean> {
    const cacheKey = VERIFIED_DOMAIN_CACHE_PREFIX + hostname;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return cached === '1';
    }

    const mapping = await appPrisma.tenantDomain.findUnique({ where: { domain: hostname } });
    const verified = mapping?.verificationStatus === 'VERIFIED';
    await this.redis.set(cacheKey, verified ? '1' : '0', 'EX', VERIFIED_DOMAIN_CACHE_TTL_SECONDS);
    if (!verified) {
      this.logger.debug(`Rejected CORS origin for unverified/unknown domain: ${hostname}`);
    }
    return verified;
  }
}
