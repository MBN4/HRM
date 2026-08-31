import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hrm/db';

/**
 * Resolves the LATEST exchange rate `asOfDate <=` the requested date — the
 * SAME "no `missing_ok`" posture Country Pack resolution already takes
 * (see docs/conventions/country-packs.md): a genuinely missing rate is a
 * loud 404, never a silent 1:1 fallback that would quietly misreport a
 * tenant's multi-currency rollup. `ExchangeRate` is global/RLS-exempt
 * (same as `CountryPack`) — reads go through the caller's own tx (RLS
 * doesn't apply to this table, but every other tenant-scoped read in the
 * same transaction still needs it), so this takes a plain `tx`, not
 * `TenantContextService`, keeping it usable from the context-less
 * `PayrollRunProcessor` worker too.
 */
@Injectable()
export class ExchangeRateService {
  async getRate(tx: Prisma.TransactionClient, baseCurrency: string, quoteCurrency: string, asOfDate: Date): Promise<Prisma.Decimal> {
    if (baseCurrency === quoteCurrency) {
      return new Prisma.Decimal(1);
    }

    const row = await tx.exchangeRate.findFirst({
      where: { baseCurrency, quoteCurrency, asOfDate: { lte: asOfDate } },
      orderBy: { asOfDate: 'desc' },
    });
    if (!row) {
      throw new NotFoundException(`No exchange rate is configured for ${baseCurrency}->${quoteCurrency} on or before ${asOfDate.toISOString().slice(0, 10)}.`);
    }
    return row.rate;
  }
}
