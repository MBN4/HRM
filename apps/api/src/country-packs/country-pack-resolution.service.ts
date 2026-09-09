import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { countryPackConfigSchema, tenantCountryOverrideSchema } from '@hrm/shared';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { EffectiveCountryPackConfig, mergeCountryPackConfig } from './country-pack-override.util';

export class CountryPackNotFoundError extends NotFoundException {
  constructor(countryCode: string) {
    super(`No active country pack is configured for country code "${countryCode}".`);
  }
}

/** Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) — a short TTL as the backstop; every real write invalidates immediately (see `invalidateForTenant`/`invalidateForCountryCode`). */
const CACHE_TTL_SECONDS = 60;

/**
 * Resolves the EFFECTIVE country configuration for a branch or country
 * code — the one place any future module (leave, payroll, employee
 * fields, ...) should go for country-dependent behavior. See /CLAUDE.md §
 * Conventions → Country packs for the full write-up, and THE RULE stated
 * there: no module may ever branch on a country code itself — everything
 * must come from here.
 *
 * Always queries through the request's own RLS-scoped transaction
 * (`TenantContextService.getTx()`), same as every other tenant-aware
 * service in this codebase — `country_packs` has no RLS policy (see
 * schema.prisma) but `tenant_country_overrides` does, so both reads must
 * run inside the same transaction the tenant context was bound to.
 *
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) —
 * `resolveEffectiveConfig`'s result is cached tenant-scoped in Redis
 * (`country-pack:effective:<tenantId>:<countryCode>`), the same
 * short-TTL-as-backstop + immediate-invalidation-on-write shape
 * `BrandingResolutionService` (4.3) already established.
 * `CountryPacksController.putOverride` invalidates the one
 * (tenant, countryCode) pair it just wrote; `PlatformCountryPackService`'s
 * mutations (a global, cross-tenant CountryPack version change — see
 * vendor-console.md) invalidate EVERY tenant's cached entry for that
 * country code via `invalidateForCountryCode` (a Redis `SCAN`, not a hot
 * path — country-pack authoring is a rare platform-admin action).
 */
@Injectable()
export class CountryPackResolutionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * `branch.countryCode` is the primary source; `tenant.defaultCountryCode`
   * is only a fallback for a branch that hasn't been assigned one (see
   * /CLAUDE.md § Conventions → Country resolution). `Branch.countryCode` is
   * a required column today, so this fallback is defensive/forward-looking
   * rather than commonly exercised — it still must not be deleted, per that
   * convention.
   */
  async resolveCountryCodeForBranch(branchId: string): Promise<string> {
    const tx = this.tenantContext.getTx();
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { countryCode: true, tenantId: true },
    });
    if (!branch) {
      throw new NotFoundException(`Branch "${branchId}" was not found.`);
    }
    if (branch.countryCode) {
      return branch.countryCode;
    }
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: branch.tenantId },
      select: { defaultCountryCode: true },
    });
    return tenant.defaultCountryCode;
  }

  /**
   * Resolves the active CountryPack for `countryCode` and layers the
   * current tenant's `TenantCountryOverride` on top, if one exists — the
   * two-layer model. Both the pack's `config` and the override's
   * `overrides` are re-validated against `@hrm/shared`'s schemas on this
   * read, not just when they were written — a JSON column carries no
   * schema-level guarantee of its own, consistent with this project's "no
   * single layer of validation is trusted alone" posture.
   */
  async resolveEffectiveConfig(countryCode: string): Promise<EffectiveCountryPackConfig> {
    const tenantId = this.tenantContext.tenantId;

    if (tenantId) {
      const cached = await this.redis.get(this.cacheKey(tenantId, countryCode));
      if (cached) {
        return JSON.parse(cached) as EffectiveCountryPackConfig;
      }
    }

    const tx = this.tenantContext.getTx();

    const packRow = await tx.countryPack.findFirst({
      where: { countryCode, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!packRow) {
      throw new CountryPackNotFoundError(countryCode);
    }
    const pack = countryPackConfigSchema.parse(packRow.config);

    if (!tenantId) {
      return pack;
    }

    const overrideRow = await tx.tenantCountryOverride.findUnique({
      where: { tenantId_countryCode: { tenantId, countryCode } },
    });
    const effective = overrideRow
      ? mergeCountryPackConfig(pack, tenantCountryOverrideSchema.parse(overrideRow.overrides))
      : pack;

    await this.redis.set(this.cacheKey(tenantId, countryCode), JSON.stringify(effective), 'EX', CACHE_TTL_SECONDS);
    return effective;
  }

  async resolveEffectiveConfigForBranch(branchId: string): Promise<EffectiveCountryPackConfig> {
    const countryCode = await this.resolveCountryCodeForBranch(branchId);
    return this.resolveEffectiveConfig(countryCode);
  }

  /** Called after a tenant writes/replaces its own override for one country — see CountryPacksController.putOverride. */
  async invalidateForTenant(tenantId: string, countryCode: string): Promise<void> {
    await this.redis.del(this.cacheKey(tenantId, countryCode));
  }

  /**
   * Called after a GLOBAL CountryPack version change (create/update/
   * activate a version) — see PlatformCountryPackService. Every tenant's
   * cached effective config for that country code is now potentially
   * stale, so this busts all of them via a non-blocking `SCAN` (never
   * `KEYS`, which blocks the whole Redis event loop) — acceptable cost for
   * a rare platform-admin action, not a per-request hot path.
   */
  async invalidateForCountryCode(countryCode: string): Promise<void> {
    const pattern = `country-pack:effective:*:${countryCode}`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  private cacheKey(tenantId: string, countryCode: string): string {
    return `country-pack:effective:${tenantId}:${countryCode}`;
  }
}
