import { BILLING_PLANS, TENANT_EDITIONS, TenantEditionKey } from '@hrm/shared';

/**
 * Edition <-> Stripe Price id mapping (step 4.2) — see
 * docs/conventions/billing.md. A real deployment configures one real
 * Stripe Price per edition (`STRIPE_PRICE_STARTER`/`_PROFESSIONAL`/
 * `_ENTERPRISE` — see apps/api/.env.example), authored in the Stripe
 * Dashboard with whatever currency/Stripe-Tax behavior that market needs.
 * Whichever of those is unset falls back to a deterministic
 * `price_mock_<edition>` id — `MockStripeClient` recognizes this shape and
 * prices it from `@hrm/shared`'s `BILLING_PLANS` reference table; a REAL
 * Stripe client would reject an unknown price id outright, which is
 * exactly the loud failure a misconfigured production deployment should
 * get (never a silent free/default price).
 */
export function priceIdForEdition(edition: TenantEditionKey, env: (key: string) => string | undefined): string {
  return env(`STRIPE_PRICE_${edition}`) || `price_mock_${edition.toLowerCase()}`;
}

const MOCK_PRICE_ID_PATTERN = /^price_mock_(starter|professional|enterprise)$/;

/** Reverse lookup — resolves a Stripe price id back to the edition it bills, when it's one this deployment configured. Null for an unrecognized price id (see StripeWebhookService — the tenant's previously-known edition is kept rather than guessed). */
export function editionForPriceId(priceId: string, env: (key: string) => string | undefined): TenantEditionKey | null {
  for (const edition of TENANT_EDITIONS) {
    if (env(`STRIPE_PRICE_${edition}`) === priceId) {
      return edition;
    }
  }
  const match = MOCK_PRICE_ID_PATTERN.exec(priceId);
  return match ? (match[1].toUpperCase() as TenantEditionKey) : null;
}

/** `MockStripeClient`-only: the reference unit amount (minor units) `price_mock_<edition>` bills at. Falls back to PROFESSIONAL's price for any other id the mock is asked to price, since it has no real Stripe catalog to consult. */
export function mockUnitAmountForPriceId(priceId: string): number {
  const match = MOCK_PRICE_ID_PATTERN.exec(priceId);
  const edition = (match ? match[1].toUpperCase() : 'PROFESSIONAL') as TenantEditionKey;
  return BILLING_PLANS[edition].seatMonthlyMinorUnits;
}
