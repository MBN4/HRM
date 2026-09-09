import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { withReplicaTenantContext } from '@hrm/db';
import { TenantContextService } from './tenant-context.service';

/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Read replicas) —
 * the one place a request handler opts a READ into the replica instead of
 * the request's own primary transaction (`TenantContextService.getTx()`).
 *
 * Deliberately a SEPARATE, ad hoc transaction against
 * `appReadReplicaPrisma` (via `withReplicaTenantContext`), not a second view
 * onto the request's already-open primary transaction — those are
 * genuinely different Postgres backends (a real streaming replica lags the
 * primary by some bounded amount), so this can never be presented as "the
 * same transaction, just faster."
 *
 * **Callers, not this service, own the primary-vs-replica judgment call.**
 * Use this ONLY for reads that are explicitly safe to be a little stale —
 * dashboards, reports, list views, precomputed analytics rollups. Never use
 * it for a read that must observe the caller's OWN just-completed write
 * (read-your-own-write) — keep using `TenantContextService.getTx()` (the
 * primary) for those, same as before this step existed. See the docs for
 * the full write-up and the worked example (`AnalyticsController`).
 */
@Injectable()
export class ReplicaReadService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async read<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }
    return withReplicaTenantContext(tenantId, fn);
  }
}
