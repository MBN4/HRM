import { Injectable } from '@nestjs/common';
import { Prisma } from '@hrm/db';
import { ExchangeRateService } from './exchange-rate.service';

export interface CurrencyRollupResult {
  rate: Prisma.Decimal;
  totalGrossBase: Prisma.Decimal;
  totalNetBase: Prisma.Decimal;
}

/**
 * Converts a run's own-currency totals into the tenant's reporting
 * currency — see docs/conventions/payroll.md's multi-currency note.
 * Resolved and SNAPSHOTTED once at calculation time (never re-resolved
 * later), the same "snapshot, don't re-derive" posture `LeaveBalance.
 * entitledDays` already takes, so a later exchange-rate update never
 * retroactively rewrites a past run's reported totals. Uses
 * `Prisma.Decimal` arithmetic throughout — never a JS float — so
 * aggregation error can't compound across many employees/branches.
 */
@Injectable()
export class MultiCurrencyRollupService {
  constructor(private readonly exchangeRates: ExchangeRateService) {}

  async rollup(
    tx: Prisma.TransactionClient,
    runCurrency: string,
    baseCurrency: string,
    asOfDate: Date,
    totalGross: Prisma.Decimal,
    totalNet: Prisma.Decimal,
  ): Promise<CurrencyRollupResult> {
    const rate = await this.exchangeRates.getRate(tx, runCurrency, baseCurrency, asOfDate);
    return {
      rate,
      totalGrossBase: totalGross.mul(rate).toDecimalPlaces(2),
      totalNetBase: totalNet.mul(rate).toDecimalPlaces(2),
    };
  }
}
