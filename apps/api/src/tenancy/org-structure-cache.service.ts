import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Prisma } from '@hrm/db';
import { REDIS_CLIENT } from '../redis/redis.constants';

const CACHE_TTL_SECONDS = 60;

export interface CachedBranch {
  id: string;
  name: string;
  countryCode: string;
}

/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Caching) — caches
 * a tenant's branch list, the "org/branch structure" hot-path read flagged
 * throughout the build (resolved fresh on nearly every request that needs
 * a country code, a branch-scoped filter, or an org-chart lookup). Same
 * shape as `BrandingResolutionService` (4.3): a short Redis TTL as the
 * safety net, an explicit `invalidate` call on every write as the PRIMARY
 * consistency mechanism, tenant-scoped key.
 *
 * Scope, deliberately narrow: this codebase has no dedicated
 * branch-management CRUD module today — branches are created by seeding or
 * by the 3.5.1 migration importers (see `BranchImporter`) — so this cache's
 * only real write-side hook is that importer. A future branch-management
 * endpoint MUST call `invalidate(tenantId)` after any create/update/delete,
 * exactly like every other cached-write pair in this step.
 */
@Injectable()
export class OrgStructureCacheService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getBranches(tx: Prisma.TransactionClient, tenantId: string): Promise<CachedBranch[]> {
    const cached = await this.redis.get(this.cacheKey(tenantId));
    if (cached) {
      return JSON.parse(cached) as CachedBranch[];
    }

    const branches = await tx.branch.findMany({
      select: { id: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
    await this.redis.set(this.cacheKey(tenantId), JSON.stringify(branches), 'EX', CACHE_TTL_SECONDS);
    return branches;
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tenantId));
  }

  private cacheKey(tenantId: string): string {
    return `org-structure:branches:${tenantId}`;
  }
}
