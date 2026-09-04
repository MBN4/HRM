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
  /**
   * The one place "how many seats does this tenant currently use" is
   * counted — reused by `check()` below AND, since step 4.2, by
   * `BillingService`/`BillingSeatMeteringService` to meter Stripe's billed
   * subscription quantity against this SAME definition (see
   * docs/conventions/billing.md's "Meter on active seats" section) — no
   * second, divergent seat-counting definition anywhere in this codebase.
   */
  async countActive(tx: Prisma.TransactionClient): Promise<number> {
    return tx.user.count({ where: { status: 'ACTIVE' } });
  }

  async check(tx: Prisma.TransactionClient, seatCap: number): Promise<SeatCapStatus> {
    const activeUserCount = await this.countActive(tx);
    return { activeUserCount, seatCap, overCap: activeUserCount > seatCap };
  }
}
