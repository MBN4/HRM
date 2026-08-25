import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';

export interface SeatCapStatus {
  activeUserCount: number;
  seatCap: number;
  overCap: boolean;
}

/**
 * Compares a tenant's active user count against a seat cap. Always
 * queries through the caller's already tenant-scoped transaction — `tx`
 * is RLS-enforced, so `tx.user.count()` counts only the calling tenant's
 * users without needing an explicit `tenantId` filter (same pattern every
 * other tenant-scoped query in this codebase relies on).
 */
@Injectable()
export class SeatCapService {
  async check(tx: Prisma.TransactionClient, seatCap: number): Promise<SeatCapStatus> {
    const activeUserCount = await tx.user.count({ where: { status: 'ACTIVE' } });
    return { activeUserCount, seatCap, overCap: activeUserCount > seatCap };
  }
}
