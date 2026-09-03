import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@hrm/db';
import { TenantRateLimitService } from '../../resilience/rate-limit/tenant-rate-limit.service';

export interface TenantUsageMetrics {
  tenantId: string;
  seats: { activeEmployees: number; licensedSeatCap: number | null; overCap: boolean };
  storage: { documentCount: number; totalBytes: number };
  apiVolume: { currentWindowCount: number; currentWindowLimit: number; windowSeconds: number };
}

/**
 * Per-tenant usage metrics for the vendor console's dashboard AND, later,
 * 4.2's real billing (flagged as its consumer in CLAUDE.md's Phase 4 note)
 * — every number here is either a cheap INDEXED count/sum (never a full
 * table scan) or a value already resolved live elsewhere in the system
 * (the rate limiter's own Redis counter), matching this step's own brief:
 * "read from existing data / rollups; don't live-aggregate heavy tables."
 *
 * HONEST GAP: there is no historical, persisted request-volume ROLLUP in
 * this system today (unlike headcount/attendance/leave, which 1.5 already
 * precomputes) — `apiVolume` is a live snapshot of the CURRENT rate-limit
 * window only, not a trend. A real time-series would need its own
 * scheduled BullMQ job writing a new rollup table, the same shape 1.5
 * established — worth building alongside 4.2's billing integration, which
 * is the first real consumer that needs a trend rather than a snapshot.
 */
@Injectable()
export class PlatformUsageService {
  constructor(private readonly tenantRateLimit: TenantRateLimitService) {}

  async getMetrics(tenantId: string): Promise<TenantUsageMetrics> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${tenantId}" was not found.`);
    }

    const [activeEmployees, storage, subscription, activeLicense, windowUsage] = await Promise.all([
      prisma.employee.count({ where: { tenantId, status: 'ACTIVE' } }),
      prisma.employeeDocument.aggregate({ where: { tenantId }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      prisma.subscription.findUnique({ where: { tenantId } }),
      prisma.license.findFirst({ where: { tenantId, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' } }),
      this.tenantRateLimit.getCurrentWindowUsage(tenantId),
    ]);

    const licensedSeatCap = activeLicense?.seatCap ?? subscription?.seatCap ?? null;

    return {
      tenantId,
      seats: {
        activeEmployees,
        licensedSeatCap,
        overCap: licensedSeatCap !== null && activeEmployees > licensedSeatCap,
      },
      storage: {
        documentCount: storage._count._all,
        totalBytes: storage._sum.sizeBytes ?? 0,
      },
      apiVolume: {
        currentWindowCount: windowUsage.count,
        currentWindowLimit: windowUsage.limit,
        windowSeconds: windowUsage.windowSeconds,
      },
    };
  }

  /**
   * Platform-wide health/overview — cheap `GROUP BY`-style counts
   * (`groupBy`, indexed on `status`/`edition`), never a per-tenant scan.
   */
  async getOverview(): Promise<{
    totalTenants: number;
    byStatus: Record<string, number>;
    byEdition: Record<string, number>;
    totalActiveEmployees: number;
    totalPlatformAdmins: number;
  }> {
    const [byStatus, byEdition, totalActiveEmployees, totalTenants, totalPlatformAdmins] = await Promise.all([
      prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.tenant.groupBy({ by: ['edition'], _count: { _all: true } }),
      prisma.employee.count({ where: { status: 'ACTIVE' } }),
      prisma.tenant.count(),
      prisma.platformAdmin.count({ where: { status: 'ACTIVE' } }),
    ]);

    return {
      totalTenants,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      byEdition: Object.fromEntries(byEdition.map((row) => [row.edition, row._count._all])),
      totalActiveEmployees,
      totalPlatformAdmins,
    };
  }
}
