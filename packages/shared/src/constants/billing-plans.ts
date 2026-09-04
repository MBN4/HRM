import type { TenantEditionKey } from './feature-flags';

/**
 * Reference SaaS pricing (step 4.2) — per-seat-per-month + a one-time
 * setup/implementation fee, by edition. Minor units (cents), matching
 * Stripe's own convention, so nothing here is ever a JS float.
 *
 * Same posture `seed-country-packs.ts` documents for its own tax/statutory
 * figures: "illustrative/rounded for a reference implementation, not
 * certified pricing" — a real deployment configures its OWN Stripe
 * Products/Prices (per edition, per currency, with Stripe Tax handling
 * regional tax) via `STRIPE_PRICE_<EDITION>` env vars (see
 * apps/api/.env.example) and this table stops being read for anything but
 * `MockStripeClient`'s own in-memory catalog (local dev/test only) and as
 * a display fallback before a tenant's first real Stripe price is known.
 * STARTER carries a real (if modest) reference price — unlike
 * `EDITION_FEATURES.STARTER` (no gated features), a tenant can still be a
 * genuine paying SaaS customer at the STARTER seat tier.
 */
export const BILLING_PLANS: Record<TenantEditionKey, { seatMonthlyMinorUnits: number; setupFeeMinorUnits: number; currency: string }> = {
  STARTER: { seatMonthlyMinorUnits: 500, setupFeeMinorUnits: 0, currency: 'usd' },
  PROFESSIONAL: { seatMonthlyMinorUnits: 1500, setupFeeMinorUnits: 50000, currency: 'usd' },
  ENTERPRISE: { seatMonthlyMinorUnits: 3500, setupFeeMinorUnits: 250000, currency: 'usd' },
};

export function billingPlanForEdition(edition: TenantEditionKey) {
  return BILLING_PLANS[edition];
}
