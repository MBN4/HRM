import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { appPrisma, Tenant } from '@hrm/db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TenantResolutionStrategy = 'subdomain' | 'custom_domain' | 'header';

const KNOWN_STRATEGIES: ReadonlySet<string> = new Set<TenantResolutionStrategy>([
  'subdomain',
  'custom_domain',
  'header',
]);

const DEFAULT_STRATEGY_ORDER: TenantResolutionStrategy[] = ['subdomain', 'custom_domain', 'header'];

export interface ResolvedTenant {
  tenantId: string;
  tenant: Tenant;
}

/**
 * Resolves the tenant for an incoming request, trying each configured
 * strategy in order until one matches. All lookups go through `appPrisma`
 * directly (no `withTenantContext` needed): `tenants` and `tenant_domains`
 * are both deliberately exempt from Row-Level Security — see schema.prisma
 * — because resolving the tenant has to happen before a tenant context
 * exists to open one with.
 */
@Injectable()
export class TenantResolutionService {
  private readonly logger = new Logger(TenantResolutionService.name);

  constructor(private readonly config: ConfigService) {}

  async resolve(req: Request): Promise<ResolvedTenant | null> {
    for (const strategy of this.strategies()) {
      // eslint-disable-next-line no-await-in-loop -- strategies are tried in order, one at a time, until one resolves
      const tenant = await this.tryStrategy(strategy, req);
      if (tenant) {
        return { tenantId: tenant.id, tenant };
      }
    }
    return null;
  }

  private strategies(): TenantResolutionStrategy[] {
    const raw = this.config.get<string>('TENANT_RESOLUTION_STRATEGIES');
    if (!raw) {
      return DEFAULT_STRATEGY_ORDER;
    }
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const unknown = parsed.filter((s) => !KNOWN_STRATEGIES.has(s));
    if (unknown.length > 0) {
      this.logger.warn(`Ignoring unknown tenant resolution strateg${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`);
    }
    const known = parsed.filter((s): s is TenantResolutionStrategy => KNOWN_STRATEGIES.has(s));
    return known.length > 0 ? known : DEFAULT_STRATEGY_ORDER;
  }

  private tryStrategy(strategy: TenantResolutionStrategy, req: Request): Promise<Tenant | null> {
    switch (strategy) {
      case 'subdomain':
        return this.resolveBySubdomain(req);
      case 'custom_domain':
        return this.resolveByCustomDomain(req);
      case 'header':
        return this.resolveByHeader(req);
    }
  }

  private resolveBySubdomain(req: Request): Promise<Tenant | null> {
    const baseDomain = this.config.get<string>('TENANT_BASE_DOMAIN');
    const host = this.hostname(req);
    if (!baseDomain || !host) {
      return Promise.resolve(null);
    }

    const suffix = `.${baseDomain.toLowerCase()}`;
    if (!host.endsWith(suffix)) {
      return Promise.resolve(null);
    }

    const slug = host.slice(0, -suffix.length);
    // Only a single label (e.g. "acme"), not a nested subdomain — a stray
    // dot means this host doesn't fit the acme.<base> shape we resolve here.
    if (!slug || slug.includes('.')) {
      return Promise.resolve(null);
    }

    return appPrisma.tenant.findUnique({ where: { slug } });
  }

  private async resolveByCustomDomain(req: Request): Promise<Tenant | null> {
    const host = this.hostname(req);
    if (!host) {
      return null;
    }
    // Step 4.3 (white-label) — a branded domain only resolves real traffic
    // once ownership is VERIFIED (see docs/conventions/white-label.md).
    // A freshly requested (PENDING_VERIFICATION) or FAILED row must never
    // match here — otherwise any tenant admin could hijack another
    // domain's traffic just by requesting it first.
    const mapping = await appPrisma.tenantDomain.findUnique({
      where: { domain: host },
      include: { tenant: true },
    });
    if (!mapping || mapping.verificationStatus !== 'VERIFIED') {
      return null;
    }
    return mapping.tenant;
  }

  private resolveByHeader(req: Request): Promise<Tenant | null> {
    const headerName = (this.config.get<string>('TENANT_HEADER_NAME') ?? 'x-tenant-id').toLowerCase();
    const raw = req.headers[headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      return Promise.resolve(null);
    }
    // The header may carry either the tenant's id or its slug — try id
    // first (a direct PK lookup) before falling back to slug.
    if (UUID_PATTERN.test(value)) {
      return appPrisma.tenant.findUnique({ where: { id: value } });
    }
    return appPrisma.tenant.findUnique({ where: { slug: value } });
  }

  private hostname(req: Request): string | null {
    const host = req.headers.host;
    if (!host) {
      return null;
    }
    return host.split(':')[0].toLowerCase();
  }
}
