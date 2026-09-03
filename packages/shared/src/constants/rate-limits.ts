import { TenantEditionKey } from './feature-flags';

export interface RateLimitConfig {
  /** Max requests allowed within `windowSeconds`. */
  limit: number;
  windowSeconds: number;
}

/**
 * Per-tenant request-volume defaults, by edition (step 0.10) — see
 * /CLAUDE.md § Conventions → Per-tenant rate limiting. Deliberately keyed
 * off `Tenant.edition` rather than `Subscription.edition` (unlike 0.6's
 * SaaS feature-flag resolution, which reads `Subscription` as its source
 * of truth): bare request-volume throttling is not a billing/entitlement
 * concern, `Tenant.edition` is always populated (defaults `STARTER`) on
 * every tenant regardless of whether a `Subscription` row exists yet, and
 * requiring one just to get a sane default rate limit would be overreach.
 * A tenant-specific override (set via the platform-admin rate-limit
 * endpoint) always wins over these defaults — see
 * `TenantRateLimitService`.
 */
export const DEFAULT_RATE_LIMITS: Record<TenantEditionKey, RateLimitConfig> = {
  STARTER: { limit: 200, windowSeconds: 60 },
  PROFESSIONAL: { limit: 500, windowSeconds: 60 },
  ENTERPRISE: { limit: 2000, windowSeconds: 60 },
};

/**
 * Per-API-KEY default (step 3.3), distinct from the per-TENANT limit above —
 * an API key is rate-limited on its own, tighter budget regardless of the
 * owning tenant's edition (`ApiKeyRateLimitService`, keyed
 * `api-key:<apiKeyId>`, same fixed-window `RateLimiterService` primitive).
 * `ApiKey.rateLimitPerMinute` overrides this per key when set.
 */
export const DEFAULT_API_KEY_RATE_LIMIT: RateLimitConfig = { limit: 300, windowSeconds: 60 };
