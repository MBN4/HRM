import type { Prisma, PrismaClient } from '@prisma/client';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Illustrative reference exchange rates for the two reference-pack
 * currencies (USD, QAR) — see docs/conventions/payroll.md's multi-currency
 * rollup note. Real rates are a future provider-integration seam (this
 * table is deliberately global/RLS-exempt and owner-role-writable only,
 * the same posture `seedCountryPacks` already takes for `CountryPack` —
 * see the ExchangeRate model's own doc comment in schema.prisma); this is
 * a fixed reference figure for local dev/tests, not a live feed.
 */
const REFERENCE_RATES: { baseCurrency: string; quoteCurrency: string; rate: string; asOfDate: string }[] = [
  { baseCurrency: 'USD', quoteCurrency: 'QAR', rate: '3.64', asOfDate: '2026-01-01' },
  { baseCurrency: 'QAR', quoteCurrency: 'USD', rate: '0.2747', asOfDate: '2026-01-01' },
];

/** Idempotent (safe to re-run): upserts each rate by its `(baseCurrency, quoteCurrency, asOfDate)` unique constraint. */
export async function seedExchangeRates(client: Client): Promise<void> {
  for (const { baseCurrency, quoteCurrency, rate, asOfDate } of REFERENCE_RATES) {
    await client.exchangeRate.upsert({
      where: { baseCurrency_quoteCurrency_asOfDate: { baseCurrency, quoteCurrency, asOfDate: new Date(asOfDate) } },
      update: { rate },
      create: { baseCurrency, quoteCurrency, rate, asOfDate: new Date(asOfDate) },
    });
  }
}
