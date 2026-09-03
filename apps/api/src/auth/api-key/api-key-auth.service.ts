import { Injectable } from '@nestjs/common';
import { prisma } from '@hrm/db';
import { HashingService } from '../../common/hashing/hashing.service';

export interface ValidatedApiKey {
  tenantId: string;
  apiKeyId: string;
  scopes: string[];
  rateLimitPerMinute: number | null;
}

/**
 * A SECOND, parallel authentication path alongside the JWT one (step 3.3) —
 * see `TenantScopeInterceptor`'s new API-key branch, which calls this
 * BEFORE `TenantResolutionService.resolve()` runs: an API key already
 * embeds which tenant it belongs to, so host/subdomain-based resolution is
 * unnecessary (and impossible to require — a generic API client has no
 * tenant subdomain to call).
 *
 * `KEY_PREFIX_LENGTH` characters of the raw key are looked up directly
 * (`ApiKey.keyPrefix`, unique per TENANT, not globally — a cross-tenant
 * prefix collision is possible in principle but statistically negligible at
 * this length, and `hashing.verify` against each candidate's actual
 * `hashedKey` is what actually decides a match, so a same-prefix key
 * belonging to a different tenant simply fails verification and is
 * skipped, never silently authenticated as the wrong tenant).
 *
 * Queries the OWNER `prisma` client directly — a deliberate, narrow
 * exception, not a violation of tenant isolation: there is no tenant
 * context yet for this exact lookup to run inside (the presented key is
 * what ESTABLISHES the tenant), the SAME class of legitimate cross-tenant
 * system read `LicensingAdminService`/`WorkflowEscalationService`/
 * `TicketSlaService` already document for themselves. Every other query for
 * the rest of the request runs through the ordinary RLS-scoped `appPrisma`
 * once `withTenantContext(tenantId, ...)` opens.
 */
export const API_KEY_PREFIX_LENGTH = 12;

@Injectable()
export class ApiKeyAuthService {
  constructor(private readonly hashing: HashingService) {}

  async validate(rawKey: string): Promise<ValidatedApiKey | null> {
    if (!rawKey || rawKey.length < API_KEY_PREFIX_LENGTH) {
      return null;
    }
    const prefix = rawKey.slice(0, API_KEY_PREFIX_LENGTH);
    const candidates = await prisma.apiKey.findMany({ where: { keyPrefix: prefix, status: 'ACTIVE' } });

    const now = new Date();
    for (const candidate of candidates) {
      if (candidate.expiresAt && candidate.expiresAt < now) {
        continue;
      }
      if (await this.hashing.verify(candidate.hashedKey, rawKey)) {
        await prisma.apiKey.update({ where: { id: candidate.id }, data: { lastUsedAt: now } });
        return {
          tenantId: candidate.tenantId,
          apiKeyId: candidate.id,
          scopes: candidate.scopes,
          rateLimitPerMinute: candidate.rateLimitPerMinute,
        };
      }
    }
    return null;
  }
}
